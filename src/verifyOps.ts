import { spawnSync } from "node:child_process";
import type { CodexProConfig } from "./config.js";
import { CodexProError, PathGuard, type Workspace } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export interface VerifyChangedJsResult {
  checked: Array<{ path: string; ok: boolean; output: string }>;
  skipped: string[];
  passed: number;
  failed: number;
}

function changedPaths(workspace: Workspace, maxOutputBytes: number): string[] {
  const result = spawnSync("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], {
    cwd: workspace.root,
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" }
  });
  if (result.error) throw new CodexProError(`git unavailable or failed: ${result.error.message}`);
  if (result.status !== 0) throw new CodexProError(result.stderr?.trim() || `git exited with status ${result.status}`);
  return String(result.stdout ?? "").split("\0").filter(Boolean);
}

export function verifyChangedJs(config: CodexProConfig, guard: PathGuard, workspace: Workspace): VerifyChangedJsResult {
  const all = changedPaths(workspace, config.maxOutputBytes);
  const candidates = all.filter((filePath) => /\.(?:js|mjs|cjs)$/i.test(filePath));
  if (candidates.length > 100) throw new CodexProError(`verify_changed_js is limited to 100 changed JS files; found ${candidates.length}.`);
  const checked: VerifyChangedJsResult["checked"] = [];
  for (const filePath of candidates) {
    const resolved = guard.resolve(workspace, filePath);
    const result = spawnSync(process.execPath, ["--check", resolved.absPath], {
      cwd: workspace.root,
      encoding: "utf8",
      maxBuffer: config.maxOutputBytes,
      env: { ...process.env, NO_COLOR: "1" }
    });
    const output = redactSensitiveText([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
    checked.push({ path: resolved.relPath, ok: !result.error && result.status === 0, output });
  }
  const candidateSet = new Set(candidates);
  const skipped = all.filter((filePath) => !candidateSet.has(filePath));
  return {
    checked,
    skipped,
    passed: checked.filter((item) => item.ok).length,
    failed: checked.filter((item) => !item.ok).length
  };
}
