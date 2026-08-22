import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { makeRestrictedBashEnv } from "./bashOps.js";
import { CodexProError } from "./guard.js";
import { redactSensitiveText } from "./redact.js";
import { loadModelPolicy, chooseProfile, capProfile, recordUsage, type Profile, type RequestedProfile } from "./usageOps.js";

const CODEX_EXECUTABLE_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex"
] as const;
const MAX_AGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_AGENT_OUTPUT_BYTES = 24_000;
const DESTRUCTIVE_TASK_PATTERN = /\b(?:delete|remove|purge|erase|rm)\b|删除|移除|清空|抹除|格式化|移动|重命名|上传|分享|复制/i;
const NEGATED_DESTRUCTIVE_PATTERN = /(?:\bdo\s+not\b|\bdon't\b|\bnever\b|不要|不允许|不得|禁止)\s*(?:delete|remove|purge|erase|rm|删除|移除|清空|抹除|格式化|移动|重命名|上传|分享|复制)/gi;

export type AgentRunMode = "read_only" | "workspace_write";

export interface AgentRunOptions {
  task: string;
  cwd: string;
  timeoutMs?: number;
  mode?: AgentRunMode;
  profile?: RequestedProfile;
  maxProfile?: Profile;
}

export interface AgentRunResult {
  status: "completed" | "failed" | "timed_out";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  mode: AgentRunMode;
  output: string;
  truncated: boolean;
  profileRequested: RequestedProfile;
  profileUsed: Profile;
  modelUsed: string | null;
  fallbackCount: number;
  usage: { input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; credits: number | null; accuracy: "exact" | "estimated" | "unknown" };
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

function appendBounded(current: string, chunk: Buffer | string, limit: number): { value: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, "utf8");
  if (currentBytes >= limit) return { value: current, truncated: true };
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
  const remaining = limit - currentBytes;
  if (buffer.byteLength <= remaining) return { value: current + buffer.toString("utf8"), truncated: false };
  return { value: current + buffer.subarray(0, remaining).toString("utf8"), truncated: true };
}

function taskPrompt(task: string, mode: AgentRunMode): string {
  return [
    "You are running as a controlled CodexPro local agent.",
    "Use only the existing Codex configuration and its configured MCP servers. Never reveal secrets, endpoints, Authorization headers, OAuth URLs, or configuration values.",
    "Never invoke Baidu Netdisk write/destructive tools. Do not delete, move, rename, copy, upload, share, or modify Baidu Netdisk content.",
    "Do not run destructive local commands or change system/LaunchAgent/network security settings.",
    mode === "read_only"
      ? "This is a read-only run: inspect and report only; do not modify workspace files."
      : "Workspace writes were explicitly confirmed for this run. Keep changes limited to the current workspace and report a concise summary.",
    "If the requested work conflicts with these constraints, stop and explain the blocked action without attempting it.",
    "\nUser task:\n" + task.trim()
  ].join("\n");
}

function requestedDestructiveOperation(task: string): boolean {
  return DESTRUCTIVE_TASK_PATTERN.test(task.replace(NEGATED_DESTRUCTIVE_PATTERN, ""));
}

function resolveCodexExecutable(): string | undefined {
  return CODEX_EXECUTABLE_CANDIDATES.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function extractUsage(output: string): { input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null; total_tokens: number | null } {
  let found: any = {};
  for (const line of output.split(/\r?\n/)) {
    try { const event = JSON.parse(line); const u = event.usage ?? event?.item?.usage ?? event?.result?.usage; if (u) found = { ...found, ...u }; } catch { /* non-json line */ }
  }
  return { input_tokens: found.input_tokens ?? null, cached_input_tokens: found.cached_input_tokens ?? null, output_tokens: found.output_tokens ?? null, total_tokens: found.total_tokens ?? null };
}

export async function runControlledCodex(config: CodexProConfig, options: AgentRunOptions): Promise<AgentRunResult> {
  const task = options.task.trim();
  if (!task) throw new CodexProError("task is required.");
  if (task.length > 16_000) throw new CodexProError("task exceeds the 16000-character limit.");
  if (requestedDestructiveOperation(task)) {
    throw new CodexProError("agent_run rejects destructive, move/rename, upload, copy, and share requests. Use a separately reviewed workflow for those operations.");
  }
  const codexExecutable = resolveCodexExecutable();
  if (!codexExecutable) throw new CodexProError("The local Codex CLI is unavailable in the approved application paths.");

  const policy = await loadModelPolicy();
  const profileRequested = options.profile ?? policy.default_profile;
  const maxProfile = options.maxProfile ?? policy.default_max_profile;
  let profileUsed = chooseProfile(task, profileRequested, maxProfile);
  const modelUsed = policy.profiles[profileUsed]?.model ?? null;
  const mode = options.mode ?? "read_only";
  const timeoutMs = Math.max(5_000, Math.min(options.timeoutMs ?? 120_000, MAX_AGENT_TIMEOUT_MS));
  const args = [
    "exec",
    "--ephemeral",
    "--json",
    ...(modelUsed ? ["--model", modelUsed] : []),
    "--skip-git-repo-check",
    "--color",
    "never",
    "--sandbox",
    mode === "workspace_write" ? "workspace-write" : "read-only",
    "--cd",
    options.cwd,
    taskPrompt(task, mode)
  ];
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(codexExecutable, args, {
      cwd: options.cwd,
      env: makeRestrictedBashEnv(config),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let output = "";
    let truncated = false;
    let timedOut = false;
    let closed = false;
    let escalation: NodeJS.Timeout | undefined;
    let inputTokens: number | null = null;
    let cachedInputTokens: number | null = null;
    let outputTokens: number | null = null;
    let totalTokens: number | null = null;
    const append = (chunk: Buffer | string) => {
      const next = appendBounded(output, chunk, MAX_AGENT_OUTPUT_BYTES);
      output = next.value;
      truncated ||= next.truncated;
      for (const line of String(chunk).split(/\r?\n/)) {
        try {
          const event = JSON.parse(line); const u = event.usage ?? event?.item?.usage ?? event?.result?.usage;
          if (u) { inputTokens ??= u.input_tokens ?? null; cachedInputTokens ??= u.cached_input_tokens ?? null; outputTokens ??= u.output_tokens ?? null; totalTokens ??= u.total_tokens ?? null; }
        } catch { /* non-JSON diagnostic line */ }
      }
      if (truncated && !closed) terminateProcessTree(child, "SIGTERM");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      escalation = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 1_500);
      escalation.unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => reject(new CodexProError(redactSensitiveText(`Codex start failed: ${error.message}`))));
    child.on("close", (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      const safeOutput = redactSensitiveText(output).trim();
      const parsedUsage = extractUsage(output);
      const usage = { ...parsedUsage, credits: null, accuracy: "unknown" as const };
      const result: AgentRunResult = {
        status: timedOut ? "timed_out" : exitCode === 0 ? "completed" : "failed",
        exitCode,
        signal,
        durationMs: Date.now() - started,
        mode,
        output: safeOutput || "(no agent output)",
        truncated,
        profileRequested,
        profileUsed,
        modelUsed,
        fallbackCount: 0,
        usage
      };
      void recordUsage({ timestamp: new Date().toISOString(), task_id: `agent-${started}`, model_used: modelUsed, profile_requested: profileRequested, profile_used: profileUsed, fallback_count: 0, duration_ms: result.durationMs, ...usage, credit_source: "none", accuracy: usage.accuracy });
      resolve(result);
    });
  });
}
