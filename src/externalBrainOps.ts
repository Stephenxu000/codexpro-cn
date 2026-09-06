import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_COMPILE_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512_000;
const DEFAULT_MAX_CONTEXT_CHARS = 7_000;
const DEFAULT_MAX_AGENT_TASK_CHARS = 15_500;
const DEFAULT_CACHE_TTL_MS = 5_000;

export type ExternalBrainStatus = "absent" | "detected" | "ready" | "unavailable";
export type ExternalBrainReasonCode =
  | "binding-missing"
  | "cli-unavailable"
  | "runtime-unavailable"
  | "invalid-output"
  | "timed-out";

export interface ExternalBrainProbe {
  provider: "adr";
  status: ExternalBrainStatus;
  binding?: string;
  projectId?: string;
  capabilities: readonly string[];
  reasonCode?: ExternalBrainReasonCode;
}

export interface ExternalBrainEnhancement {
  task: string;
  used: boolean;
  probe: ExternalBrainProbe;
  materialCount: number;
  stages: readonly string[];
  compilationStatus?: string;
}

export interface ExternalBrainCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  startError?: string;
}

export interface ExternalBrainCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ExternalBrainCommandRunner = (
  executable: string,
  args: readonly string[],
  options: Readonly<ExternalBrainCommandOptions>
) => Promise<ExternalBrainCommandResult>;

export interface AdrExternalBrainOptions {
  executable?: string;
  runner?: ExternalBrainCommandRunner;
  probeTimeoutMs?: number;
  compileTimeoutMs?: number;
  maxOutputBytes?: number;
  maxContextChars?: number;
  maxAgentTaskChars?: number;
  cacheTtlMs?: number;
}

interface ProbeCacheEntry {
  expiresAt: number;
  result: ExternalBrainProbe;
}

const probeCache = new Map<string, ProbeCacheEntry>();

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function executableCandidates(explicit?: string): string[] {
  const fromPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.join(entry, "adr"));
  return [...new Set([
    explicit?.trim() || "",
    process.env.CODEXPRO_ADR_BIN?.trim() || "",
    path.join(os.homedir(), ".local", "bin", "adr"),
    "/opt/homebrew/bin/adr",
    "/usr/local/bin/adr",
    ...fromPath
  ].filter(Boolean))];
}

function resolveAdrExecutable(explicit?: string): string | undefined {
  for (const candidate of executableCandidates(explicit)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync.native(candidate);
    } catch {
      // Optional capability: keep searching approved local executable locations.
    }
  }
  return undefined;
}

function adrEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const passthrough = [
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "ADR_LOCAL_CONFIG",
    "ADR_PROJECT_ID",
    "ADR_STORE",
    "ADR_BRAIN_ROOT",
    "ADR_BRAIN_HOME"
  ] as const;
  for (const key of passthrough) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.NO_COLOR = "1";
  return env;
}

const defaultRunner: ExternalBrainCommandRunner = (executable, args, options) =>
  new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        env: adrEnvironment(),
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        windowsHide: true,
        shell: false,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && "killed" in error && error.killed);
        const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        const startError = error && "code" in error && typeof error.code === "string" ? error.code : undefined;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode: code,
          timedOut,
          ...(startError ? { startError } : {})
        });
      }
    );
  });

function unavailable(binding: string | undefined, reasonCode: ExternalBrainReasonCode): ExternalBrainProbe {
  return {
    provider: "adr",
    status: reasonCode === "binding-missing" ? "absent" : "unavailable",
    ...(binding ? { binding } : {}),
    capabilities: [],
    reasonCode
  };
}

function isUnenrolledResolution(result: ExternalBrainCommandResult): boolean {
  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return message.includes("not enrolled in the configured adr project registry")
    || message.includes("project identity is required");
}

function detectedProbeFromResolve(value: unknown, workspaceRoot: string): ExternalBrainProbe | undefined {
  const root = objectValue(value);
  if (root?.command !== "resolve") return undefined;
  const context = objectValue(root.context);
  const projectId = typeof context?.projectId === "string" && context.projectId.trim()
    ? context.projectId.trim()
    : undefined;
  if (!projectId) return undefined;
  const projectConfigPath = typeof context?.projectConfigPath === "string" && context.projectConfigPath.trim()
    ? context.projectConfigPath.trim()
    : undefined;
  const binding = projectConfigPath
    ? path.relative(workspaceRoot, projectConfigPath) || path.basename(projectConfigPath)
    : "central-registry";
  return {
    provider: "adr",
    status: "detected",
    binding,
    projectId,
    capabilities: []
  };
}

export async function detectExternalBrain(
  workspace: Workspace,
  options: AdrExternalBrainOptions = {}
): Promise<ExternalBrainProbe> {
  const executable = resolveAdrExecutable(options.executable);
  if (!executable) return unavailable(undefined, "cli-unavailable");
  const runner = options.runner ?? defaultRunner;
  const result = await runner(executable, ["resolve", "--json"], {
    cwd: workspace.root,
    timeoutMs: clamp(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 250, 30_000),
    maxOutputBytes: clamp(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 16_000, 2_000_000)
  });
  if (result.exitCode !== 0) {
    if (isUnenrolledResolution(result)) return unavailable(undefined, "binding-missing");
    return commandFailure(undefined, result);
  }
  return detectedProbeFromResolve(parseJson(result.stdout), workspace.root)
    ?? unavailable(undefined, "invalid-output");
}

function parseJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readyProbeFromMachineResult(
  value: unknown,
  binding: string,
  expectedCommand: "context-plan" | "context-compile"
): ExternalBrainProbe | undefined {
  const root = objectValue(value);
  if (root?.command !== expectedCommand) return undefined;
  const request = objectValue(root.request);
  const project = objectValue(request?.project);
  const projectId = typeof project?.id === "string" && project.id.trim() ? project.id.trim() : undefined;
  if (!projectId) return undefined;
  const plan = objectValue(root.plan);
  const stages = Array.isArray(plan?.stages) ? plan.stages : [];
  const capabilities = [...new Set(stages.flatMap((entry) => {
    const stage = objectValue(entry);
    const providerIds = Array.isArray(stage?.providerIds) ? stage.providerIds : [];
    return typeof stage?.stage === "string" && providerIds.length > 0 ? [stage.stage] : [];
  }))].sort();
  return {
    provider: "adr",
    status: "ready",
    binding,
    projectId,
    capabilities
  };
}

function commandFailure(binding: string | undefined, result: ExternalBrainCommandResult): ExternalBrainProbe {
  if (result.timedOut) return unavailable(binding, "timed-out");
  if (result.startError === "ENOENT" || result.startError === "EACCES") return unavailable(binding, "cli-unavailable");
  return unavailable(binding, "runtime-unavailable");
}

function sourceLabel(source: unknown): string {
  const value = objectValue(source);
  if (!value) return "derived";
  const kind = typeof value.kind === "string" ? value.kind : "derived";
  const mount = typeof value.mount === "string" ? value.mount : undefined;
  const relPath = typeof value.path === "string" ? value.path : undefined;
  const symbol = typeof value.symbol === "string" ? value.symbol : undefined;
  const knowledgeId = typeof value.knowledgeId === "string" ? value.knowledgeId : undefined;
  const artifactId = typeof value.artifactId === "string" ? value.artifactId : undefined;
  if (mount && relPath) return `${kind}:${mount}:${relPath}${symbol ? `#${symbol}` : ""}`;
  if (knowledgeId) return `${kind}:${knowledgeId}`;
  if (artifactId) return `${kind}:${artifactId}`;
  return kind;
}

function bounded(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24))}\n...[ADR context truncated]`;
}

function renderCompilation(value: unknown, maxChars: number): {
  text: string;
  materialCount: number;
  stages: readonly string[];
  compilationStatus?: string;
} | undefined {
  const root = objectValue(value);
  if (root?.command !== "context-compile") return undefined;
  const pack = objectValue(root.pack);
  const materials = Array.isArray(pack?.materials) ? pack.materials : undefined;
  if (!materials) return undefined;
  const status = typeof root.status === "string" ? root.status : undefined;
  const reason = typeof root.reason === "string" ? redactSensitiveText(root.reason) : undefined;
  const sections: string[] = [
    "# ADR External Brain Context",
    "",
    `Compilation: ${status ?? "unknown"}${reason ? ` — ${reason}` : ""}`,
    "This is supplemental project context with ADR provenance. If ADR reports uncertainty or structural-only evidence, verify against concrete source before changing code."
  ];
  const stages: string[] = [];
  for (const raw of materials) {
    const material = objectValue(raw);
    if (!material) continue;
    const stage = typeof material.stage === "string" ? material.stage : "context";
    const providerId = typeof material.providerId === "string" ? material.providerId : "unknown-provider";
    const content = typeof material.content === "string" ? redactSensitiveText(material.content).trim() : "";
    stages.push(stage);
    sections.push(
      "",
      `## ${stage} · ${providerId}`,
      `Source: ${sourceLabel(material.source)}`,
      "",
      content || "(no rendered content)"
    );
  }
  return {
    text: bounded(sections.join("\n"), maxChars),
    materialCount: materials.length,
    stages: [...new Set(stages)],
    ...(status ? { compilationStatus: status } : {})
  };
}

export async function probeExternalBrain(
  workspace: Workspace,
  options: AdrExternalBrainOptions = {}
): Promise<ExternalBrainProbe> {
  const detected = await detectExternalBrain(workspace, options);
  if (detected.status !== "detected" || !detected.binding) return detected;

  const cacheTtlMs = clamp(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 60_000);
  const cacheKey = `${workspace.root}\u0000${detected.projectId ?? "unknown"}`;
  const cached = probeCache.get(cacheKey);
  if (cacheTtlMs > 0 && cached && cached.expiresAt >= Date.now()) return cached.result;

  const executable = resolveAdrExecutable(options.executable);
  if (!executable) return unavailable(detected.binding, "cli-unavailable");
  const runner = options.runner ?? defaultRunner;
  const result = await runner(
    executable,
    ["context-plan", "--mode", "light", "--json"],
    {
      cwd: workspace.root,
      timeoutMs: clamp(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 250, 30_000),
      maxOutputBytes: clamp(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 16_000, 2_000_000)
    }
  );
  const probe = result.exitCode === 0
    ? readyProbeFromMachineResult(parseJson(result.stdout), detected.binding, "context-plan")
      ?? unavailable(detected.binding, "invalid-output")
    : commandFailure(detected.binding, result);
  if (cacheTtlMs > 0) {
    probeCache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, result: probe });
  }
  return probe;
}

export async function enrichTaskWithExternalBrain(
  workspace: Workspace,
  task: string,
  options: AdrExternalBrainOptions = {}
): Promise<ExternalBrainEnhancement> {
  const original = task.trim();
  const detected = await detectExternalBrain(workspace, options);
  if (detected.status !== "detected" || !detected.binding) {
    return { task: original, used: false, probe: detected, materialCount: 0, stages: [] };
  }

  const executable = resolveAdrExecutable(options.executable);
  if (!executable) {
    return {
      task: original,
      used: false,
      probe: unavailable(detected.binding, "cli-unavailable"),
      materialCount: 0,
      stages: []
    };
  }

  const maxTaskChars = clamp(options.maxAgentTaskChars, DEFAULT_MAX_AGENT_TASK_CHARS, 2_000, 64_000);
  const remainingTaskBudget = Math.max(0, maxTaskChars - original.length - 80);
  if (remainingTaskBudget < 800) {
    return { task: original, used: false, probe: detected, materialCount: 0, stages: [] };
  }
  const maxContextChars = Math.min(
    remainingTaskBudget,
    clamp(options.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS, 800, 24_000)
  );
  const runner = options.runner ?? defaultRunner;
  const result = await runner(
    executable,
    [
      "context-compile",
      "--mode",
      "light",
      "--task",
      original.slice(0, 4_000),
      "--json"
    ],
    {
      cwd: workspace.root,
      timeoutMs: clamp(options.compileTimeoutMs, DEFAULT_COMPILE_TIMEOUT_MS, 500, 60_000),
      maxOutputBytes: clamp(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 16_000, 2_000_000)
    }
  );
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      task: original,
      used: false,
      probe: commandFailure(detected.binding, result),
      materialCount: 0,
      stages: []
    };
  }
  const machineResult = parseJson(result.stdout);
  const ready = readyProbeFromMachineResult(machineResult, detected.binding, "context-compile");
  const rendered = renderCompilation(machineResult, maxContextChars);
  if (!ready || !rendered || rendered.materialCount === 0) {
    return {
      task: original,
      used: false,
      probe: ready ?? unavailable(detected.binding, "invalid-output"),
      materialCount: 0,
      stages: []
    };
  }

  return {
    task: `${original}\n\n---\n\n${rendered.text}`,
    used: true,
    probe: ready,
    materialCount: rendered.materialCount,
    stages: rendered.stages,
    ...(rendered.compilationStatus ? { compilationStatus: rendered.compilationStatus } : {})
  };
}
