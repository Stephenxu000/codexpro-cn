import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { CodexProConfig } from "./config.js";
import { CodexProError, isSubpath, type Workspace } from "./guard.js";

interface WorkUnitFileState {
  path: string;
  fingerprint: string;
}

export interface WorkUnitRecord {
  version: 1;
  id: string;
  workspace_id: string;
  workspace_root: string;
  title: string;
  allowed_paths: string[];
  started_at: string;
  branch: string;
  head: string;
  baseline: WorkUnitFileState[];
}

export interface WorkUnitFinishResult {
  work_unit: WorkUnitRecord;
  finished_at: string;
  branch: string;
  head: string;
  changed_paths: string[];
  newly_touched_paths: string[];
  baseline_paths_changed_again: string[];
  out_of_scope_paths: string[];
  branch_changed: boolean;
  head_changed: boolean;
}

const WORK_UNIT_ID_RE = /^wu_[a-f0-9]{24}$/;
const STATE_ROOT = path.join(os.homedir(), "Library", "Application Support", "CodexPro", "work-units");

function git(workspace: Workspace, args: string[]): Buffer {
  const result = spawnSync("git", args, {
    cwd: workspace.root,
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" }
  });
  if (result.error) throw new CodexProError(`git unavailable or failed: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
    throw new CodexProError(stderr || `git exited with status ${result.status}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

function gitText(workspace: Workspace, args: string[]): string {
  return git(workspace, args).toString("utf8").trim();
}

function statusPaths(workspace: Workspace): string[] {
  const raw = git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = raw.toString("utf8").split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const firstPath = entry.slice(3);
    if (firstPath) paths.push(firstPath);
    if ((status.includes("R") || status.includes("C")) && entries[i + 1]) {
      paths.push(entries[i + 1]);
      i += 1;
    }
  }
  return [...new Set(paths)].sort();
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileFingerprint(workspace: Workspace, relPath: string): string {
  const absolute = path.resolve(workspace.root, relPath);
  if (!isSubpath(absolute, workspace.root)) return "outside";
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
    cwd: workspace.root,
    stdio: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  }).status === 0;
  if (tracked) {
    return hashBuffer(git(workspace, ["diff", "HEAD", "--binary", "--no-ext-diff", "--", relPath]));
  }
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(absolute)}`;
    if (!stat.isFile()) return `other:${stat.mode}:${stat.size}`;
    const maxBytes = 2 * 1024 * 1024;
    const fd = fs.openSync(absolute, "r");
    try {
      const size = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, 0);
      return `untracked:${stat.size}:${hashBuffer(buffer)}`;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "missing";
  }
}

function snapshot(workspace: Workspace): WorkUnitFileState[] {
  return statusPaths(workspace).map((filePath) => ({ path: filePath, fingerprint: fileFingerprint(workspace, filePath) }));
}

function recordPath(id: string): string {
  if (!WORK_UNIT_ID_RE.test(id)) throw new CodexProError(`Invalid work_unit_id: ${id}`);
  return path.join(STATE_ROOT, `${id}.json`);
}

function writeRecord(record: WorkUnitRecord): void {
  fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  const target = recordPath(record.id);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, target);
  fs.chmodSync(target, 0o600);
}

export function readWorkUnit(id: string): WorkUnitRecord {
  const target = recordPath(id);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw new CodexProError(`Unknown work_unit_id: ${id}`);
  }
  const record = parsed as Partial<WorkUnitRecord>;
  if (record.version !== 1 || record.id !== id || typeof record.workspace_id !== "string" || typeof record.workspace_root !== "string") {
    throw new CodexProError(`Invalid work unit state: ${id}`);
  }
  return record as WorkUnitRecord;
}

export function startWorkUnit(
  _config: CodexProConfig,
  workspace: Workspace,
  options: { title?: string; allowedPaths?: string[] }
): WorkUnitRecord {
  const id = `wu_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const record: WorkUnitRecord = {
    version: 1,
    id,
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    title: options.title?.trim() || "Development work unit",
    allowed_paths: [...new Set(options.allowedPaths ?? [])].sort(),
    started_at: new Date().toISOString(),
    branch: gitText(workspace, ["branch", "--show-current"]),
    head: gitText(workspace, ["rev-parse", "HEAD"]),
    baseline: snapshot(workspace)
  };
  writeRecord(record);
  return record;
}

function withinAllowed(filePath: string, allowedPaths: string[]): boolean {
  if (!allowedPaths.length) return true;
  return allowedPaths.some((allowed) => filePath === allowed || filePath.startsWith(`${allowed.replace(/\/$/, "")}/`));
}

export function finishWorkUnit(workspace: Workspace, id: string): WorkUnitFinishResult {
  const record = readWorkUnit(id);
  if (record.workspace_id !== workspace.id || record.workspace_root !== workspace.root) {
    throw new CodexProError(`work_unit_id ${id} belongs to a different workspace.`);
  }
  const current = snapshot(workspace);
  const baseline = new Map(record.baseline.map((item) => [item.path, item.fingerprint]));
  const currentMap = new Map(current.map((item) => [item.path, item.fingerprint]));
  const allPaths = [...new Set([...baseline.keys(), ...currentMap.keys()])].sort();
  const touched = allPaths.filter((filePath) => baseline.get(filePath) !== currentMap.get(filePath));
  const newlyTouched = touched.filter((filePath) => !baseline.has(filePath));
  const baselineChangedAgain = touched.filter((filePath) => baseline.has(filePath));
  const outOfScope = touched.filter((filePath) => !withinAllowed(filePath, record.allowed_paths));
  const branch = gitText(workspace, ["branch", "--show-current"]);
  const head = gitText(workspace, ["rev-parse", "HEAD"]);
  const result: WorkUnitFinishResult = {
    work_unit: record,
    finished_at: new Date().toISOString(),
    branch,
    head,
    changed_paths: current.map((item) => item.path),
    newly_touched_paths: newlyTouched,
    baseline_paths_changed_again: baselineChangedAgain,
    out_of_scope_paths: outOfScope,
    branch_changed: branch !== record.branch,
    head_changed: head !== record.head
  };
  try {
    fs.unlinkSync(recordPath(id));
  } catch {
    // The result is authoritative; cleanup is best-effort if the runtime state file was already removed.
  }
  return result;
}
