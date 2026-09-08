import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "./guard.js";

const execFileAsync = promisify(execFile);
const DEFAULT_STATE_ROOT = path.join(os.homedir(), "Library", "Application Support", "CodexPro");
const DEFAULT_BEGIN_TIMEOUT_MS = 15_000;
const DEFAULT_COMPLETE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_STALE_SESSION_MS = 2 * 60 * 60_000;
const MAX_MODEL_CONTEXT_CHARS = 7_000;
const MAX_ADR_OUTPUT_BYTES = 2 * 1024 * 1024;

export type AdrHostPresentation = {
  visibility: "show" | "silent";
  impact: "assurance" | "intervention" | "none";
  slot: "completion";
  text: string;
};

export type AdrHostCompletion = {
  status: "completed" | "idle" | "unavailable";
  outcome?: string;
  presentation?: AdrHostPresentation;
  error?: string;
  recoveredStale?: boolean;
};

export type AdrHostBegin = {
  status: "tracked" | "existing" | "passthrough" | "unavailable";
  error?: string;
  modelContext?: string;
  recoveredOrphan?: boolean;
};

export type AdrHostMutationHint = {
  tool: string;
  task?: string;
  paths?: string[];
};

type PersistedSession = {
  workspaceId: string;
  root: string;
  sessionId: string;
  startedAt: string;
  lastMutationAt?: string;
};

type PersistedState = {
  version: 1;
  sessions: Record<string, PersistedSession>;
};

type AdrCommandResult = {
  stdout: string;
  stderr: string;
};

export type AdrHostOrchestratorOptions = {
  adrBin?: string;
  stateRoot?: string;
  hostId?: string;
  beginTimeoutMs?: number;
  completeTimeoutMs?: number;
  staleSessionMs?: number;
  env?: NodeJS.ProcessEnv;
};

function safeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 1200);
  return String(error).slice(0, 1200);
}

function isMissingAdrHostSession(error: unknown): boolean {
  const text = safeError(error).toLowerCase();
  return text.includes("host-session.json") && (text.includes("enoent") || text.includes("no such file or directory"));
}

function boundedText(value: string, maxChars = MAX_MODEL_CONTEXT_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 32))}\n...[ADR context truncated]`;
}

function defaultAdrBin(): string {
  const configured = process.env.ADR_BIN?.trim();
  if (configured) return configured;
  for (const candidate of ["/opt/homebrew/bin/adr", "/usr/local/bin/adr"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "adr";
}

function emptyState(): PersistedState {
  return { version: 1, sessions: {} };
}

function isSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.workspaceId === "string" &&
    typeof item.root === "string" &&
    typeof item.sessionId === "string" &&
    typeof item.startedAt === "string"
  );
}

function normalizeState(value: unknown): PersistedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState();
  const raw = value as { version?: unknown; sessions?: unknown };
  if (raw.version !== 1 || !raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions)) return emptyState();
  const sessions: Record<string, PersistedSession> = {};
  for (const [workspaceId, session] of Object.entries(raw.sessions as Record<string, unknown>)) {
    if (!isSession(session) || session.workspaceId !== workspaceId) continue;
    sessions[workspaceId] = session;
  }
  return { version: 1, sessions };
}

async function readJson(pathname: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fsp.readFile(pathname, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireProcessLock(lockPath: string): Promise<() => Promise<void>> {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, "utf8");
      await handle.close();
      return async () => {
        try {
          await fsp.unlink(lockPath);
        } catch {
          // Best-effort release. A later caller can recover a dead-owner lock.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = (await readJson(lockPath)) as { pid?: unknown } | undefined;
      if (owner && typeof owner.pid === "number" && !pidAlive(owner.pid)) {
        try {
          await fsp.unlink(lockPath);
          continue;
        } catch {
          // Another process may have recovered it first.
        }
      }
      throw new Error("ADR Host workspace lifecycle is busy in another CodexPro process.");
    }
  }
  throw new Error("ADR Host workspace lifecycle lock could not be acquired.");
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ADR CLI returned a non-object JSON payload.");
  return parsed as Record<string, unknown>;
}

function parsePresentation(value: unknown): AdrHostPresentation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    (item.visibility !== "show" && item.visibility !== "silent") ||
    (item.impact !== "assurance" && item.impact !== "intervention" && item.impact !== "none") ||
    item.slot !== "completion" ||
    typeof item.text !== "string"
  ) return undefined;
  return {
    visibility: item.visibility,
    impact: item.impact,
    slot: "completion",
    text: item.text
  };
}

function mutationTask(hint: AdrHostMutationHint): string {
  const explicit = hint.task?.trim();
  if (explicit) return explicit.slice(0, 500);
  const paths = (hint.paths ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 8);
  const suffix = paths.length ? ` (${paths.join(", ")})` : "";
  return `CodexPro direct ${hint.tool} workspace change${suffix}`.slice(0, 500);
}

function adrChildEnv(base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...base,
    ...overrides,
    NO_COLOR: "1",
    CI: overrides.CI ?? base.CI ?? "1"
  };
  for (const key of Object.keys(merged)) {
    if (key.startsWith("CODEXPRO_") || key.startsWith("CODEBASE_BRIDGE_")) delete merged[key];
  }
  return merged;
}

export class AdrHostOrchestrator {
  private readonly adrBin: string;
  private readonly stateRoot: string;
  private readonly statePath: string;
  private readonly lockRoot: string;
  private readonly stateWriteLock: string;
  private readonly hostId: string;
  private readonly beginTimeoutMs: number;
  private readonly completeTimeoutMs: number;
  private readonly staleSessionMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: AdrHostOrchestratorOptions = {}) {
    this.adrBin = options.adrBin ?? defaultAdrBin();
    this.stateRoot = options.stateRoot ?? process.env.CODEXPRO_ADR_HOST_STATE_DIR?.trim() ?? DEFAULT_STATE_ROOT;
    this.statePath = path.join(this.stateRoot, "adr-host-sessions.json");
    this.lockRoot = path.join(this.stateRoot, "adr-host-locks");
    this.stateWriteLock = path.join(this.stateRoot, "adr-host-state.lock");
    this.hostId = options.hostId ?? "codexpro-mcp";
    this.beginTimeoutMs = options.beginTimeoutMs ?? DEFAULT_BEGIN_TIMEOUT_MS;
    this.completeTimeoutMs = options.completeTimeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS;
    this.staleSessionMs = Math.max(60_000, options.staleSessionMs ?? DEFAULT_STALE_SESSION_MS);
    this.env = adrChildEnv(process.env, options.env);
  }

  private workspaceLockPath(workspace: Workspace): string {
    return path.join(this.lockRoot, `${workspace.id}.lock`);
  }

  private async readState(): Promise<PersistedState> {
    return normalizeState(await readJson(this.statePath));
  }

  private async writeState(mutator: (state: PersistedState) => void): Promise<void> {
    const release = await acquireProcessLock(this.stateWriteLock);
    try {
      await fsp.mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
      const state = await this.readState();
      mutator(state);
      const temp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fsp.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await fsp.rename(temp, this.statePath);
        await fsp.chmod(this.statePath, 0o600);
      } finally {
        try {
          await fsp.unlink(temp);
        } catch {
          // Atomic rename already consumed it or no temp was created.
        }
      }
    } finally {
      await release();
    }
  }

  private async runAdr(workspace: Workspace, args: string[], timeoutMs: number): Promise<AdrCommandResult> {
    const result = await execFileAsync(this.adrBin, args, {
      cwd: workspace.root,
      env: this.env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_ADR_OUTPUT_BYTES,
      windowsHide: true
    });
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  }

  private sessionIsStale(session: PersistedSession, now = Date.now()): boolean {
    const last = Date.parse(session.lastMutationAt ?? session.startedAt);
    return Number.isFinite(last) && now - last >= this.staleSessionMs;
  }

  private async completeLocked(
    workspace: Workspace,
    status: "succeeded" | "failed" | "cancelled",
    recoveredStale = false
  ): Promise<AdrHostCompletion> {
    const state = await this.readState();
    const current = state.sessions[workspace.id];
    if (!current || path.resolve(current.root) !== path.resolve(workspace.root)) return { status: "idle" };

    const result = await this.runAdr(
      workspace,
      ["host-complete", "--session", current.sessionId, "--status", status, "--locale", "zh-CN", "--json"],
      this.completeTimeoutMs
    );
    const payload = parseJsonObject(result.stdout);
    const presentation = parsePresentation(payload.presentation);
    const outcome = typeof payload.status === "string" ? payload.status : undefined;
    await this.writeState((next) => {
      delete next.sessions[workspace.id];
    });
    return {
      status: "completed",
      ...(outcome ? { outcome } : {}),
      ...(presentation ? { presentation } : {}),
      ...(recoveredStale ? { recoveredStale: true } : {})
    };
  }

  async beforeMutation(workspace: Workspace, hint: AdrHostMutationHint): Promise<AdrHostBegin> {
    let release: (() => Promise<void>) | undefined;
    let hadTrackedSession = false;
    let recoveredOrphan = false;
    try {
      release = await acquireProcessLock(this.workspaceLockPath(workspace));
      const state = await this.readState();
      const current = state.sessions[workspace.id];
      hadTrackedSession = Boolean(current && path.resolve(current.root) === path.resolve(workspace.root));
      if (current && path.resolve(current.root) === path.resolve(workspace.root)) {
        if (this.sessionIsStale(current)) {
          try {
            await this.completeLocked(workspace, "cancelled", true);
          } catch (error) {
            if (!isMissingAdrHostSession(error)) throw error;
            await this.writeState((next) => {
              delete next.sessions[workspace.id];
            });
            recoveredOrphan = true;
          }
          hadTrackedSession = false;
        } else {
          const now = new Date().toISOString();
          await this.writeState((next) => {
            const existing = next.sessions[workspace.id];
            if (existing && path.resolve(existing.root) === path.resolve(workspace.root)) existing.lastMutationAt = now;
          });
          return { status: "existing" };
        }
      }

      if (current) {
        await this.writeState((next) => {
          delete next.sessions[workspace.id];
        });
      }

      const result = await this.runAdr(
        workspace,
        ["host-begin", "--task", mutationTask(hint), "--host", this.hostId, "--json"],
        this.beginTimeoutMs
      );
      const payload = parseJsonObject(result.stdout);
      const status = typeof payload.status === "string" ? payload.status : "";
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      const modelContext = typeof payload.modelContext === "string" ? boundedText(payload.modelContext) : "";
      if (status === "tracked" && sessionId) {
        const now = new Date().toISOString();
        const record: PersistedSession = {
          workspaceId: workspace.id,
          root: workspace.root,
          sessionId,
          startedAt: now,
          lastMutationAt: now
        };
        await this.writeState((next) => {
          next.sessions[workspace.id] = record;
        });
        return {
          status: "tracked",
          ...(modelContext ? { modelContext } : {}),
          ...(recoveredOrphan ? { recoveredOrphan: true } : {})
        };
      }
      return { status: "passthrough" };
    } catch (error) {
      if (hadTrackedSession) throw error;
      return { status: "unavailable", error: safeError(error) };
    } finally {
      if (release) await release();
    }
  }

  async complete(workspace: Workspace, status: "succeeded" | "failed" | "cancelled" = "succeeded"): Promise<AdrHostCompletion> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireProcessLock(this.workspaceLockPath(workspace));
      return await this.completeLocked(workspace, status);
    } catch (error) {
      return { status: "unavailable", error: safeError(error) };
    } finally {
      if (release) await release();
    }
  }

  async recoverStale(workspace: Workspace): Promise<AdrHostCompletion> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireProcessLock(this.workspaceLockPath(workspace));
      const state = await this.readState();
      const current = state.sessions[workspace.id];
      if (!current || path.resolve(current.root) !== path.resolve(workspace.root) || !this.sessionIsStale(current)) {
        return { status: "idle" };
      }
      return await this.completeLocked(workspace, "cancelled", true);
    } catch (error) {
      return { status: "unavailable", error: safeError(error) };
    } finally {
      if (release) await release();
    }
  }

  async active(workspace: Workspace): Promise<boolean> {
    const state = await this.readState();
    const current = state.sessions[workspace.id];
    return Boolean(current && path.resolve(current.root) === path.resolve(workspace.root));
  }
}

export function decorateAdrHostMutationResult(result: any, begin: AdrHostBegin | undefined): any {
  if (!begin || (begin.status !== "tracked" && begin.status !== "existing")) return result;
  const contextText = begin.status === "tracked" && begin.modelContext ? begin.modelContext.trim() : "";
  const lifecycleHint = begin.recoveredOrphan
    ? "ADR Host 已丢弃一个后端记录缺失的旧 session；旧改动只作为新 baseline，未被重新证明。继续本轮工作前请把它们视为未验证历史；完成前调用 show_changes。"
    : "ADR Host 已跟踪本轮改动；在向用户报告完成前调用 show_changes，以执行可信验证并输出收敛结果。";
  const injectedText = contextText
    ? `${lifecycleHint}\n\n## ADR Project Context for subsequent steps\n\n${contextText}`
    : lifecycleHint;
  const content = Array.isArray(result?.content) ? [...result.content] : [];
  const textIndex = content.findIndex((item) => item && item.type === "text" && typeof item.text === "string");
  if (textIndex >= 0) content[textIndex] = { ...content[textIndex], text: `${content[textIndex].text}\n\n${injectedText}` };
  else content.push({ type: "text", text: injectedText });
  const structured = result?.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
    ? result.structuredContent
    : {};
  return {
    ...result,
    content,
    structuredContent: {
      ...structured,
      adr_host: {
        status: begin.status,
        tracking: true,
        completion_tool: "show_changes",
        ...(contextText ? { context_injected: true } : {}),
        ...(begin.recoveredOrphan ? { recovered_orphan: true } : {})
      }
    }
  };
}

export function decorateAdrHostResult(result: any, completion: AdrHostCompletion | undefined): any {
  if (!completion || completion.status === "idle") return result;
  const presentation = completion.presentation;
  const visibleText = presentation?.visibility === "show"
    ? presentation.text.trim()
    : completion.status === "unavailable"
      ? `ADR ⚠ 收敛验证不可用：${completion.error ?? "unknown error"}`
      : completion.recoveredStale
        ? "ADR · 已将长期未收尾的旧 Work Session 按 cancelled 回收；未将其冒充为已验证完成。"
        : "";
  const content = Array.isArray(result?.content) ? [...result.content] : [];
  if (visibleText) {
    const textIndex = content.findIndex((item) => item && item.type === "text" && typeof item.text === "string");
    if (textIndex >= 0) content[textIndex] = { ...content[textIndex], text: `${content[textIndex].text}\n\n${visibleText}` };
    else content.push({ type: "text", text: visibleText });
  }
  const structured = result?.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
    ? result.structuredContent
    : {};
  return {
    ...result,
    content,
    structuredContent: {
      ...structured,
      adr_host: {
        status: completion.status,
        outcome: completion.outcome ?? null,
        ...(completion.error ? { error: completion.error } : {}),
        ...(completion.recoveredStale ? { recovered_stale: true } : {}),
        ...(presentation ? { presentation } : {})
      }
    }
  };
}

export function createAdrHostOrchestrator(options: AdrHostOrchestratorOptions = {}): AdrHostOrchestrator {
  return new AdrHostOrchestrator(options);
}
