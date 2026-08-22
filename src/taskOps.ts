import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { serverAdminPath } from "./localPaths.js";

const TASK_ROOT = process.env.CODEXPRO_TASK_ROOT?.trim() || serverAdminPath("state", "codexpro-tasks");
const TASK_ID_RE = /^task-[0-9]{14}-[a-f0-9]{10}$/;
const MAX_PLAN_BYTES = 32_000;
const MAX_RESULT_BYTES = 120_000;
const BRIDGE_TASK_VERSION = 3;
const BRIDGE_BACKEND = "codexpro-agent-run";
const TERMINAL = new Set<TaskStatus>(["completed", "failed", "interrupted", "cancelled"]);

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
export type TaskMode = "read_only" | "workspace_write";
export type TaskProfile = "auto" | "economy" | "balanced" | "power";
export type TaskMaxProfile = "economy" | "balanced" | "power";

export interface BridgeTaskRecord {
  version: 3;
  backend: "codexpro-agent-run";
  id: string;
  title: string;
  workspace: string;
  agent: "codex";
  model: null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  attempts: number;
  timeout_ms: number;
  mode: TaskMode;
  profile: TaskProfile;
  max_profile: TaskMaxProfile;
  resources: string[];
  control_token_sha256: string;
  exit_code?: number | null;
  signal?: string | null;
  duration_ms?: number;
  last_error?: string;
  model_used?: string | null;
  profile_used?: string | null;
}

export interface BridgeTaskExecutionRequest {
  task: BridgeTaskRecord;
  plan: string;
}

export interface BridgeTaskExecutionResult {
  status: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  output: string;
  modelUsed?: string | null;
  profileUsed?: string | null;
  usage?: unknown;
}

export interface CreateBridgeTaskInput {
  title: string;
  workspace: string;
  plan: string;
  timeoutMs?: number;
  mode?: TaskMode;
  profile?: TaskProfile;
  maxProfile?: TaskMaxProfile;
}

type TaskExecutor = (request: BridgeTaskExecutionRequest) => Promise<BridgeTaskExecutionResult>;

let executor: TaskExecutor | undefined;
let schedulerInitialized = false;
let schedulerPumping = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
const scheduled = new Set<string>();
const taskLocks = new Map<string, Promise<void>>();

async function withTaskLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  validateTaskId(id);
  const previous = taskLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  taskLocks.set(id, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (taskLocks.get(id) === tail) taskLocks.delete(id);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function taskId(): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `task-${stamp}-${randomBytes(5).toString("hex")}`;
}

function validateTaskId(id: string): string {
  if (!TASK_ID_RE.test(id)) throw new Error("Invalid task_id.");
  return id;
}

function dirFor(id: string): string {
  return path.join(TASK_ROOT, validateTaskId(id));
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function assertToken(task: BridgeTaskRecord, token: string): void {
  const expected = Buffer.from(task.control_token_sha256, "hex");
  const actual = hashToken(token);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("TASK_TOKEN_INVALID");
  }
}

async function atomicWrite(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, data, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function readTaskRaw(id: string): Promise<BridgeTaskRecord> {
  const task = await readJson<BridgeTaskRecord>(path.join(dirFor(id), "task.json"));
  if (task.version !== BRIDGE_TASK_VERSION || task.backend !== BRIDGE_BACKEND || task.id !== id) {
    throw new Error("TASK_NOT_BRIDGE_MANAGED");
  }
  return task;
}

function publicTask(task: BridgeTaskRecord): Omit<BridgeTaskRecord, "control_token_sha256"> {
  const { control_token_sha256: _secret, ...visible } = task;
  return visible;
}

async function writeTask(task: BridgeTaskRecord): Promise<void> {
  const dir = dirFor(task.id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await atomicJson(path.join(dir, "task.json"), task);
  await atomicJson(path.join(dir, "status.json"), {
    version: 1,
    task_id: task.id,
    status: task.status,
    updated_at: task.updated_at,
    started_at: task.started_at,
    finished_at: task.finished_at,
    attempts: task.attempts,
    exit_code: task.exit_code,
    signal: task.signal,
    duration_ms: task.duration_ms,
    last_error: task.last_error,
    model_used: task.model_used,
    profile_used: task.profile_used
  });
}

function boundedText(value: string, maxBytes = MAX_RESULT_BYTES): string {
  const buffer = Buffer.from(value ?? "", "utf8");
  if (buffer.byteLength <= maxBytes) return value ?? "";
  return buffer.subarray(buffer.byteLength - maxBytes).toString("utf8");
}

async function writeResult(task: BridgeTaskRecord, resultText: string): Promise<void> {
  const body = [
    `# ${task.title}`,
    "",
    `- Task: ${task.id}`,
    `- Status: ${task.status}`,
    `- Attempts: ${task.attempts}`,
    `- Updated: ${task.updated_at}`,
    task.model_used ? `- Model: ${task.model_used}` : "",
    task.profile_used ? `- Profile: ${task.profile_used}` : "",
    "",
    "## Result",
    "",
    boundedText(resultText || task.last_error || "No result output.")
  ].filter(Boolean).join("\n");
  await atomicWrite(path.join(dirFor(task.id), "result.md"), `${body}\n`);
}

function schedule(id: string): void {
  scheduled.add(validateTaskId(id));
  void pump();
}

async function scanPending(): Promise<void> {
  await fs.mkdir(TASK_ROOT, { recursive: true, mode: 0o700 });
  let entries: string[] = [];
  try {
    entries = await fs.readdir(TASK_ROOT);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!TASK_ID_RE.test(name)) continue;
    try {
      const task = await readTaskRaw(name);
      if (task.status === "pending") scheduled.add(name);
    } catch {
      // Ignore legacy/v2 task directories and malformed unrelated entries.
    }
  }
  void pump();
}

async function initializeScheduler(): Promise<void> {
  if (schedulerInitialized) return;
  schedulerInitialized = true;
  await fs.mkdir(TASK_ROOT, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(TASK_ROOT).catch(() => [] as string[]);
  for (const name of entries) {
    if (!TASK_ID_RE.test(name)) continue;
    try {
      const task = await readTaskRaw(name);
      if (task.status === "running") {
        task.status = "interrupted";
        task.updated_at = nowIso();
        task.finished_at = task.updated_at;
        task.last_error = "CodexPro process restarted while this task was running; retry is required.";
        await writeTask(task);
        await writeResult(task, task.last_error);
      } else if (task.status === "pending") {
        scheduled.add(name);
      }
    } catch {
      // Ignore legacy/v2 task directories and malformed unrelated entries.
    }
  }
  pollTimer = setInterval(() => void scanPending(), 2_000);
  pollTimer.unref?.();
  void pump();
}

async function pump(): Promise<void> {
  if (schedulerPumping || !executor) return;
  schedulerPumping = true;
  try {
    while (scheduled.size > 0) {
      const id = scheduled.values().next().value as string;
      scheduled.delete(id);
      let claimed: { task: BridgeTaskRecord; plan: string } | null;
      try {
        claimed = await withTaskLock(id, async () => {
          const task = await readTaskRaw(id);
          if (task.status !== "pending") return null;
          const plan = await fs.readFile(path.join(dirFor(id), "plan.md"), "utf8");
          task.status = "running";
          task.attempts += 1;
          task.started_at = nowIso();
          task.updated_at = task.started_at;
          delete task.finished_at;
          delete task.exit_code;
          delete task.signal;
          delete task.duration_ms;
          delete task.last_error;
          await writeTask(task);
          return { task: { ...task }, plan };
        });
      } catch {
        continue;
      }
      if (!claimed) continue;

      try {
        const result = await executor(claimed);
        await withTaskLock(id, async () => {
          const task = await readTaskRaw(id);
          if (task.status !== "running") return;
          task.exit_code = result.exitCode;
          task.signal = result.signal;
          task.duration_ms = result.durationMs;
          task.model_used = result.modelUsed ?? null;
          task.profile_used = result.profileUsed ?? null;
          const succeeded = result.status === "completed" && (result.exitCode === null || result.exitCode === 0);
          task.status = succeeded ? "completed" : "failed";
          task.updated_at = nowIso();
          task.finished_at = task.updated_at;
          if (!succeeded) task.last_error = boundedText(result.output || result.status, 4_000);
          await writeResult(task, result.output);
          await writeTask(task);
        });
      } catch (error) {
        await withTaskLock(id, async () => {
          const task = await readTaskRaw(id);
          if (task.status !== "running") return;
          task.status = "failed";
          task.updated_at = nowIso();
          task.finished_at = task.updated_at;
          task.last_error = boundedText(error instanceof Error ? error.message : String(error), 4_000);
          await writeResult(task, task.last_error);
          await writeTask(task);
        });
      }
    }
  } finally {
    schedulerPumping = false;
    if (scheduled.size > 0) queueMicrotask(() => void pump());
  }
}

export function configureLocalTaskExecutor(nextExecutor: TaskExecutor): void {
  if (!executor) executor = nextExecutor;
  void initializeScheduler();
}

export async function createLocalTask(input: CreateBridgeTaskInput): Promise<{
  task: Omit<BridgeTaskRecord, "control_token_sha256">;
  task_token: string;
}> {
  const planBytes = Buffer.byteLength(input.plan, "utf8");
  if (!input.plan.trim() || planBytes > MAX_PLAN_BYTES) throw new Error("TASK_PLAN_INVALID");
  if (!input.title.trim() || input.title.length > 160) throw new Error("TASK_TITLE_INVALID");
  const id = taskId();
  const token = randomBytes(24).toString("base64url");
  const now = nowIso();
  const task: BridgeTaskRecord = {
    version: 3,
    backend: BRIDGE_BACKEND,
    id,
    title: input.title.trim(),
    workspace: input.workspace,
    agent: "codex",
    model: null,
    status: "pending",
    created_at: now,
    updated_at: now,
    attempts: 0,
    timeout_ms: Math.max(5_000, Math.min(input.timeoutMs ?? 300_000, 600_000)),
    mode: input.mode ?? "read_only",
    profile: input.profile ?? "auto",
    max_profile: input.maxProfile ?? "balanced",
    resources: [`workspace:${input.workspace}`],
    control_token_sha256: hashToken(token).toString("hex")
  };
  const dir = dirFor(id);
  await fs.mkdir(dir, { recursive: false, mode: 0o700 });
  await atomicWrite(path.join(dir, "plan.md"), `${input.plan.trim()}\n`);
  await writeTask(task);
  schedule(id);
  return { task: publicTask(task), task_token: token };
}

export async function getLocalTask(id: string, token: string): Promise<{
  task: Omit<BridgeTaskRecord, "control_token_sha256">;
  result: string | null;
}> {
  const task = await readTaskRaw(id);
  assertToken(task, token);
  let result: string | null = null;
  try {
    result = boundedText(await fs.readFile(path.join(dirFor(id), "result.md"), "utf8"));
  } catch {
    result = null;
  }
  return { task: publicTask(task), result };
}

export async function listLocalTasks(limit = 30): Promise<{
  counts: Record<string, number>;
  tasks: Array<{ task_id: string; status: TaskStatus; created_at: string; updated_at: string }>;
}> {
  await fs.mkdir(TASK_ROOT, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(TASK_ROOT).catch(() => [] as string[]);
  const rows: BridgeTaskRecord[] = [];
  for (const name of entries) {
    if (!TASK_ID_RE.test(name)) continue;
    try {
      rows.push(await readTaskRaw(name));
    } catch {
      // Ignore non-bridge tasks.
    }
  }
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const counts: Record<string, number> = {};
  for (const task of rows) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return {
    counts,
    tasks: rows.slice(0, Math.max(1, Math.min(limit, 100))).map((task) => ({
      task_id: task.id,
      status: task.status,
      created_at: task.created_at,
      updated_at: task.updated_at
    }))
  };
}

export async function waitLocalTask(id: string, token: string, maxWaitSeconds = 20): Promise<{
  task: Omit<BridgeTaskRecord, "control_token_sha256">;
  result: string | null;
}> {
  const deadline = Date.now() + Math.max(0, Math.min(maxWaitSeconds, 30)) * 1_000;
  while (true) {
    const current = await getLocalTask(id, token);
    if (TERMINAL.has(current.task.status) || Date.now() >= deadline) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function cancelLocalTask(id: string, token: string): Promise<Omit<BridgeTaskRecord, "control_token_sha256">> {
  return withTaskLock(id, async () => {
    const task = await readTaskRaw(id);
    assertToken(task, token);
    if (task.status !== "pending") throw new Error("TASK_NOT_PENDING");
    task.status = "cancelled";
    task.updated_at = nowIso();
    task.finished_at = task.updated_at;
    task.last_error = "Cancelled before local execution.";
    scheduled.delete(id);
    await writeResult(task, task.last_error);
    await writeTask(task);
    return publicTask(task);
  });
}

export async function retryLocalTask(id: string, token: string): Promise<Omit<BridgeTaskRecord, "control_token_sha256">> {
  const task = await withTaskLock(id, async () => {
    const current = await readTaskRaw(id);
    assertToken(current, token);
    if (!TERMINAL.has(current.status) || current.status === "completed") throw new Error("TASK_NOT_RETRYABLE");
    current.status = "pending";
    current.updated_at = nowIso();
    delete current.started_at;
    delete current.finished_at;
    delete current.exit_code;
    delete current.signal;
    delete current.duration_ms;
    delete current.last_error;
    delete current.model_used;
    delete current.profile_used;
    await writeTask(current);
    return publicTask(current);
  });
  schedule(id);
  return task;
}
