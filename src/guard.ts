import fs from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { CodexProConfig } from "./config.js";
import { expandHome } from "./config.js";

export interface Workspace {
  id: string;
  root: string;
  openedAt: string;
}

// Explicit workspace ids survive separate MCP server objects and bridge restarts.
// Connection/session state never decides which non-default workspace a tool targets.
const sharedWorkspaces = new Map<string, Workspace>();
const CODEXPRO_STATE_DIR = path.join(os.homedir(), "Library", "Application Support", "CodexPro");
const WORKSPACE_REGISTRY_PATH = path.join(CODEXPRO_STATE_DIR, "workspaces.json");
const LEGACY_WORKSPACE_REGISTRY_PATH = path.join(os.homedir(), "ServerAdmin", "state", "codexpro-workspaces.json");
const WORKSPACE_ID_RE = /^ws_[a-f0-9]{24}$/;

export class CodexProError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexProError";
  }
}

export function isSubpath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeRelPath(relPath: string): string {
  const normalized = relPath.split(path.sep).join("/");
  if (normalized === "") return ".";
  return normalized;
}

export function displayPath(absPath: string, root: string): string {
  const rel = path.relative(root, absPath) || ".";
  return normalizeRelPath(rel);
}

function workspaceIdForRoot(realRoot: string): string {
  return `ws_${createHash("sha256").update(realRoot).digest("hex").slice(0, 24)}`;
}

function readWorkspaceRegistry(): Record<string, string> {
  const valid: Record<string, string> = {};
  for (const registryPath of [LEGACY_WORKSPACE_REGISTRY_PATH, WORKSPACE_REGISTRY_PATH]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const workspaces = (parsed as { workspaces?: unknown }).workspaces;
      if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) continue;
      for (const [id, root] of Object.entries(workspaces as Record<string, unknown>)) {
        if (!WORKSPACE_ID_RE.test(id) || typeof root !== "string" || !root) continue;
        const realRoot = maybeRealpath(root);
        if (!realRoot || workspaceIdForRoot(realRoot) !== id) continue;
        valid[id] = realRoot;
      }
    } catch {
      // Missing/invalid registries are ignored; explicit roots are always revalidated.
    }
  }
  return valid;
}

function persistWorkspace(workspace: Workspace): void {
  const directory = path.dirname(WORKSPACE_REGISTRY_PATH);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const workspaces = readWorkspaceRegistry();
  workspaces[workspace.id] = workspace.root;
  const temp = `${WORKSPACE_REGISTRY_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, WORKSPACE_REGISTRY_PATH);
    fs.chmodSync(WORKSPACE_REGISTRY_PATH, 0o600);
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function persistedWorkspaceRoot(id: string): string | undefined {
  if (!WORKSPACE_ID_RE.test(id)) return undefined;
  const root = readWorkspaceRegistry()[id];
  if (!root) return undefined;
  const realRoot = maybeRealpath(root);
  if (!realRoot || workspaceIdForRoot(realRoot) !== id) return undefined;
  return realRoot;
}

function maybeRealpath(existingPath: string): string | undefined {
  try {
    return fs.realpathSync.native(existingPath);
  } catch {
    return undefined;
  }
}

function closestExistingParent(absPath: string): string {
  let current = path.resolve(absPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(private readonly config: CodexProConfig) {}

  defaultWorkspace(): Workspace {
    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === this.config.defaultRoot);
    return existing ?? this.openWorkspace(this.config.defaultRoot);
  }

  openWorkspace(rootInput?: string): Workspace {
    const requested = rootInput?.trim() ? expandHome(rootInput.trim()) : this.config.defaultRoot;
    const resolved = path.resolve(requested);
    if (!fs.existsSync(resolved)) {
      throw new CodexProError(`Workspace root does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new CodexProError(`Workspace root is not a directory: ${resolved}`);
    }
    const realRoot = fs.realpathSync.native(resolved);
    const allowed = this.config.allowedRoots.some((allowedRoot) => isSubpath(realRoot, allowedRoot));
    if (!allowed) {
      throw new CodexProError(
        `Workspace root is outside allowed roots: ${realRoot}\nAllowed roots:\n${this.config.allowedRoots.map((r) => `- ${r}`).join("\n")}`
      );
    }
    const blockedRoot = this.config.allowedRoots.some((allowedRoot) => {
      if (!isSubpath(realRoot, allowedRoot)) return false;
      const relative = normalizeRelPath(path.relative(allowedRoot, realRoot));
      if (relative === ".") return false;
      return this.config.blockedGlobs.some(
        (glob) =>
          minimatch(relative, glob, { dot: true, nocase: false, matchBase: false }) ||
          minimatch(path.basename(relative), glob, { dot: true, nocase: false, matchBase: true })
      );
    });
    if (blockedRoot) throw new CodexProError(`Workspace root is blocked by safety rules: ${realRoot}`);

    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === realRoot);
    if (existing) {
      sharedWorkspaces.set(existing.id, existing);
      persistWorkspace(existing);
      return existing;
    }

    const id = workspaceIdForRoot(realRoot);
    const workspace = { id, root: realRoot, openedAt: new Date().toISOString() };
    this.workspaces.set(id, workspace);
    sharedWorkspaces.set(id, workspace);
    persistWorkspace(workspace);
    return workspace;
  }

  getWorkspace(id?: string): Workspace {
    if (!id) return this.defaultWorkspace();
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      const shared = sharedWorkspaces.get(id);
      if (shared) return this.openWorkspace(shared.root);
      const persistedRoot = persistedWorkspaceRoot(id);
      if (persistedRoot) return this.openWorkspace(persistedRoot);
      const configuredRoot = this.config.allowedRoots.find((allowedRoot) => workspaceIdForRoot(allowedRoot) === id);
      if (configuredRoot) return this.openWorkspace(configuredRoot);
    }
    if (!workspace) {
      throw new CodexProError(`Unknown workspace_id: ${id}. Call open_workspace first.`);
    }
    return workspace;
  }

  listWorkspaces(): Workspace[] {
    const merged = new Map<string, Workspace>(sharedWorkspaces);
    for (const [id, workspace] of this.workspaces) merged.set(id, workspace);
    return [...merged.values()];
  }
}

export class PathGuard {
  constructor(private readonly config: CodexProConfig) {}

  isBlockedRelativePath(relPath: string): boolean {
    const rel = normalizeRelPath(relPath).replace(/^\.\//, "");
    if (!rel || rel === ".") return false;
    return this.config.blockedGlobs.some((glob) =>
      minimatch(rel, glob, { dot: true, nocase: false, matchBase: false }) ||
      minimatch(path.basename(rel), glob, { dot: true, nocase: false, matchBase: true })
    );
  }

  assertNotBlocked(relPath: string): void {
    if (this.isBlockedRelativePath(relPath)) {
      throw new CodexProError(`Path is blocked by safety rules: ${relPath}`);
    }
  }

  resolve(workspace: Workspace, inputPath = ".", options: { forWrite?: boolean } = {}): { absPath: string; relPath: string } {
    const expanded = expandHome(inputPath || ".");
    const candidate = path.isAbsolute(expanded) ? expanded : path.join(workspace.root, expanded);
    let absPath = path.resolve(candidate);
    const realTarget = maybeRealpath(absPath);
    let relPath = displayPath(absPath, workspace.root);

    if (!isSubpath(absPath, workspace.root)) {
      if (realTarget && isSubpath(realTarget, workspace.root)) {
        absPath = realTarget;
        relPath = displayPath(realTarget, workspace.root);
      } else if (options.forWrite) {
        const parent = closestExistingParent(path.dirname(absPath));
        const realParent = maybeRealpath(parent);
        if (!realParent || !isSubpath(realParent, workspace.root)) {
          throw new CodexProError(`Path escapes workspace root: ${inputPath}`);
        }
        absPath = path.resolve(realParent, path.relative(parent, absPath));
        relPath = displayPath(absPath, workspace.root);
      } else {
        throw new CodexProError(`Path escapes workspace root: ${inputPath}`);
      }
    }

    this.assertNotBlocked(relPath);

    if (realTarget) {
      if (!isSubpath(realTarget, workspace.root)) {
        throw new CodexProError(`Path resolves outside workspace root through a symlink: ${inputPath}`);
      }
      const realRel = displayPath(realTarget, workspace.root);
      this.assertNotBlocked(realRel);
    }

    if (options.forWrite) {
      const writeTarget = realTarget ?? absPath;
      const readOnlyRoot = this.config.readOnlyRoots.find((root) => isSubpath(writeTarget, root) || isSubpath(workspace.root, root));
      if (readOnlyRoot) {
        throw new CodexProError(`Workspace is read-only for this operation: ${workspace.root}`);
      }
      try {
        if (fs.lstatSync(absPath).isSymbolicLink()) {
          throw new CodexProError(`Refusing to write through a symlink: ${inputPath}`);
        }
      } catch (error) {
        if (error instanceof CodexProError) throw error;
      }
      const parent = closestExistingParent(path.dirname(absPath));
      const realParent = maybeRealpath(parent);
      if (realParent && !isSubpath(realParent, workspace.root)) {
        throw new CodexProError(`Write path resolves through a parent outside the workspace: ${inputPath}`);
      }
      if (realParent) {
        const realParentRel = displayPath(realParent, workspace.root);
        this.assertNotBlocked(realParentRel);
      }
    }

    return { absPath, relPath };
  }

  async assertTextFile(absPath: string, maxBytes: number): Promise<void> {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      throw new CodexProError(`Not a file: ${absPath}`);
    }
    if (stat.size > maxBytes) {
      throw new CodexProError(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
    }
    if (stat.size === 0) return;
    const handle = await fsp.open(absPath, "r");
    try {
      const sample = Buffer.alloc(Math.min(64 * 1024, stat.size));
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(sample, 0, sample.length, offset);
        if (bytesRead === 0) break;
        if (sample.subarray(0, bytesRead).includes(0)) {
          throw new CodexProError("Refusing to read binary file.");
        }
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
}

export function userHome(): string {
  return os.homedir();
}
