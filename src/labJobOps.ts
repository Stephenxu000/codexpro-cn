import { execFile } from "node:child_process";
import { CodexProError } from "./guard.js";
import { serverAdminPath } from "./localPaths.js";
import { redactSensitiveText } from "./redact.js";

const NODE_PATH = process.execPath;
const RUNNER_PATH = process.env.CODEXPRO_LAB_JOB_RUNNER?.trim() || serverAdminPath("scripts", "lab-job-call.mjs");
const TIMEOUT_MS = 40_000;
const MAX_ARGS_BYTES = 100_000;
const MAX_OUTPUT_BYTES = 120_000;
const JOB_ID_RE = /^[a-f0-9]{16}$/;
const ACTION_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function runRunner(argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      NODE_PATH,
      [RUNNER_PATH, ...argv],
      { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 150_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = redactSensitiveText(String(stderr ?? "")).trim().slice(0, 500);
          reject(new CodexProError(`Lab job runner failed: ${detail || "runner_failed"}.`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export async function callLabJob(
  jobId: string,
  actionInput: string,
  input: Record<string, unknown>
): Promise<{ job_id: string; action: string; result: unknown }> {
  if (!JOB_ID_RE.test(jobId)) throw new CodexProError("Invalid Lab job id.");
  const action = String(actionInput ?? "").trim();
  if (!ACTION_RE.test(action)) throw new CodexProError("Invalid Lab job action.");
  const inputJson = JSON.stringify(input ?? {});
  if (Buffer.byteLength(inputJson, "utf8") > MAX_ARGS_BYTES) throw new CodexProError("Lab job arguments are too large.");

  const stdout = await runRunner([jobId, action, inputJson]);
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) throw new CodexProError("Lab job output is too large.");
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim() || "{}");
  } catch {
    throw new CodexProError("Lab job runner returned invalid JSON.");
  }
  return { job_id: jobId, action, result: payload };
}
