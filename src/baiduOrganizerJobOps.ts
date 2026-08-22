import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { CodexProError } from "./guard.js";
import { serverAdminPath } from "./localPaths.js";
import { redactSensitiveText } from "./redact.js";

const CONFIG_PATH = process.env.CODEXPRO_BAIDU_ORGANIZER_CONFIG?.trim() || serverAdminPath("config", "baidu-organizer.json");
const NODE_PATH = process.execPath;
const RUNNER_PATH = process.env.CODEXPRO_BAIDU_ORGANIZER_RUNNER?.trim() || serverAdminPath("scripts", "baidu-organizer-session.mjs");
const TIMEOUT_MS = 45_000;
const MAX_ARGS_BYTES = 100_000;
const MAX_OUTPUT_BYTES = 100_000;
const JOB_ID_RE = /^[a-f0-9]{16}$/;
const LOCAL_ACTIONS = new Set(["job_info", "state_read", "state_write", "state_append"]);

interface OrganizerConfig {
  read_actions?: unknown;
  write_actions?: unknown;
}

function safeActionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 64);
}

async function allowedActions(): Promise<Set<string>> {
  let parsed: OrganizerConfig;
  try {
    parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as OrganizerConfig;
  } catch {
    throw new CodexProError("ServerAdmin organizer configuration is unavailable.");
  }
  return new Set([
    ...LOCAL_ACTIONS,
    ...safeActionList(parsed.read_actions),
    ...safeActionList(parsed.write_actions)
  ]);
}

function runRunner(argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      NODE_PATH,
      [RUNNER_PATH, ...argv],
      { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 120_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = redactSensitiveText(String(stderr ?? "")).trim().slice(0, 500);
          reject(new CodexProError(`Baidu organizer job runner failed: ${detail || "runner_failed"}.`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export async function callBaiduOrganizerJob(
  jobId: string,
  actionInput: string,
  input: Record<string, unknown>
): Promise<{ job_id: string; action: string; result: unknown }> {
  if (!JOB_ID_RE.test(jobId)) throw new CodexProError("Invalid Baidu organizer job id.");
  const action = String(actionInput ?? "").trim();
  if (!action || action.length > 64) throw new CodexProError("Invalid Baidu organizer job action.");
  const allowed = await allowedActions();
  if (!allowed.has(action)) throw new CodexProError("Baidu organizer job action is not allowed.");

  const inputJson = JSON.stringify(input ?? {});
  if (Buffer.byteLength(inputJson, "utf8") > MAX_ARGS_BYTES) {
    throw new CodexProError("Baidu organizer job arguments are too large.");
  }

  const stdout = await runRunner([jobId, action, inputJson]);
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
    throw new CodexProError("Baidu organizer job output is too large.");
  }

  let result: unknown;
  try {
    result = JSON.parse(stdout.trim() || "{}");
  } catch {
    throw new CodexProError("Baidu organizer job runner returned invalid JSON.");
  }
  return { job_id: jobId, action, result };
}
