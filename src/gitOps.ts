import { spawnSync } from "node:child_process";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export interface GitActionResult {
  action: string;
  stdout: string;
  branch: string;
  head: string;
  status: string;
}

type RawGitResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

function runGitRaw(workspace: Workspace, args: string[], maxOutputBytes: number, input?: string): RawGitResult {
  const result = spawnSync("git", args, {
    cwd: workspace.root,
    encoding: "utf8",
    input,
    maxBuffer: maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" }
  });
  return {
    status: result.status,
    stdout: redactSensitiveText(result.stdout?.trim() || ""),
    stderr: redactSensitiveText(result.stderr?.trim() || ""),
    error: result.error
  };
}

function runGit(workspace: Workspace, args: string[], maxOutputBytes: number): string {
  const result = runGitRaw(workspace, args, maxOutputBytes);
  if (result.error) return `git unavailable or failed: ${result.error.message}`;
  if (result.status !== 0) return result.stderr || result.stdout || `git exited with status ${result.status}`;
  return result.stdout || "(no output)";
}

function runGitChecked(config: CodexProConfig, workspace: Workspace, args: string[], input?: string): string {
  const result = runGitRaw(workspace, args, config.maxOutputBytes, input);
  if (result.error) throw new CodexProError(`git unavailable or failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new CodexProError(result.stderr || result.stdout || `git exited with status ${result.status}`);
  }
  return result.stdout || "(no output)";
}

function isGitFailure(output: string): boolean {
  const trimmed = output.trim().toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    trimmed.includes("not a git repository")
  );
}

function outputLines(output: string): string[] {
  return output.trim() === "(no output)" ? [] : output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function assertSafeRef(ref: string, label = "Git ref"): string {
  const value = ref.trim();
  if (!value || value.length > 200) throw new CodexProError(`${label} must be 1-200 characters.`);
  if (value.startsWith("-") || /[\s~^:?*\[\\]/.test(value) || value.includes("..") || value.includes("@{") || value.endsWith("/") || value.endsWith(".")) {
    throw new CodexProError(`Invalid ${label.toLowerCase()}: ${value}`);
  }
  return value;
}

function safePaths(guard: PathGuard, workspace: Workspace, paths: string[]): string[] {
  const normalized = [...new Set(paths.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (!normalized.length) throw new CodexProError("At least one workspace-relative path is required.");
  if (normalized.length > 200) throw new CodexProError("A single Git action is limited to 200 paths.");
  return normalized.map((item) => guard.resolve(workspace, item).relPath);
}

function actionResult(config: CodexProConfig, workspace: Workspace, action: string, stdout: string): GitActionResult {
  const branch = runGitChecked(config, workspace, ["branch", "--show-current"]);
  const head = runGitChecked(config, workspace, ["rev-parse", "--short=12", "HEAD"]);
  const status = gitStatus(config, workspace);
  return {
    action,
    stdout,
    branch: branch === "(no output)" ? "" : branch,
    head: head === "(no output)" ? "" : head,
    status
  };
}

function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git a/")) continue;
    const match = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
    if (!match) throw new CodexProError("git_stage_hunks currently requires unquoted workspace-relative paths without spaces.");
    paths.add(match[1]);
    paths.add(match[2]);
  }
  return [...paths];
}

export function gitStatus(config: CodexProConfig, workspace: Workspace, guard?: PathGuard, filePath?: string, staged = false): string {
  const args = staged ? ["diff", "--cached", "--name-status"] : ["status", "--short", "--branch"];
  if (filePath?.trim()) {
    if (!guard) return "path-scoped git status requires a path guard";
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

export function gitDiff(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

export function gitDiffStatus(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--name-status"];
  if (staged) args.push("--staged");
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
    untrackedArgs.push("--", resolved.relPath);
  }
  const diffStatus = runGit(workspace, args, config.maxOutputBytes);
  if (staged || isGitFailure(diffStatus)) return diffStatus;
  const untracked = runGit(workspace, untrackedArgs, config.maxOutputBytes);
  if (isGitFailure(untracked)) return diffStatus;
  const lines = [...outputLines(diffStatus), ...outputLines(untracked).map((line) => `?? ${line}`)];
  return lines.length ? lines.join("\n") : "(no output)";
}

export function gitLog(config: CodexProConfig, workspace: Workspace, maxCount = 8): string {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  return runGit(workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
}

export function gitSwitch(config: CodexProConfig, workspace: Workspace, branchInput: string): GitActionResult {
  const branch = assertSafeRef(branchInput, "branch");
  const stdout = runGitChecked(config, workspace, ["switch", branch]);
  return actionResult(config, workspace, "switch", stdout);
}

export function gitCreateBranch(config: CodexProConfig, workspace: Workspace, branchInput: string): GitActionResult {
  const branch = assertSafeRef(branchInput, "branch");
  const stdout = runGitChecked(config, workspace, ["switch", "-c", branch]);
  return actionResult(config, workspace, "create_branch", stdout);
}

export function gitStage(config: CodexProConfig, guard: PathGuard, workspace: Workspace, paths: string[]): GitActionResult {
  const resolved = safePaths(guard, workspace, paths);
  const stdout = runGitChecked(config, workspace, ["add", "--", ...resolved]);
  return actionResult(config, workspace, "stage", stdout);
}

export function gitStageHunks(config: CodexProConfig, guard: PathGuard, workspace: Workspace, patchInput: string): GitActionResult {
  const patch = patchInput.trimEnd() + "\n";
  if (!patch.trim()) throw new CodexProError("Patch is required.");
  if (Buffer.byteLength(patch, "utf8") > 500_000) throw new CodexProError("Patch is limited to 500 KB.");
  const paths = patchPaths(patch);
  if (!paths.length) throw new CodexProError("Patch must contain at least one git diff --git file header.");
  safePaths(guard, workspace, paths);

  // The reverse check proves these exact hunks are already present in the working tree.
  // The cached check proves the current index can accept them. Together this prevents
  // git_stage_hunks from inventing index-only content that does not exist in the workspace.
  runGitChecked(config, workspace, ["apply", "--reverse", "--check", "--whitespace=nowarn"], patch);
  runGitChecked(config, workspace, ["apply", "--cached", "--check", "--whitespace=nowarn"], patch);
  const stdout = runGitChecked(config, workspace, ["apply", "--cached", "--whitespace=nowarn"], patch);
  return actionResult(config, workspace, "stage_hunks", stdout);
}

export function gitCommit(config: CodexProConfig, workspace: Workspace, messageInput: string): GitActionResult {
  const message = messageInput.trim();
  if (!message || message.length > 500) throw new CodexProError("Commit message must be 1-500 characters.");
  const stdout = runGitChecked(config, workspace, ["commit", "-m", message]);
  return actionResult(config, workspace, "commit", stdout);
}

export function gitMerge(config: CodexProConfig, workspace: Workspace, branchInput: string): GitActionResult {
  const branch = assertSafeRef(branchInput, "branch");
  const stdout = runGitChecked(config, workspace, ["merge", "--no-edit", branch]);
  return actionResult(config, workspace, "merge", stdout);
}

export function gitStash(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { action: "push" | "list" | "apply" | "pop"; message?: string; includeUntracked?: boolean; paths?: string[]; ref?: string }
): GitActionResult {
  if (options.action === "list") {
    const stdout = runGitChecked(config, workspace, ["stash", "list", "--format=%gd%x09%s"]);
    return actionResult(config, workspace, "stash_list", stdout);
  }
  if (options.action === "apply" || options.action === "pop") {
    const ref = options.ref?.trim() || "stash@{0}";
    if (!/^stash@\{\d+\}$/.test(ref)) throw new CodexProError(`Invalid stash ref: ${ref}`);
    const stdout = runGitChecked(config, workspace, ["stash", options.action, ref]);
    return actionResult(config, workspace, `stash_${options.action}`, stdout);
  }

  const args = ["stash", "push"];
  if (options.includeUntracked === true) args.push("--include-untracked");
  const message = options.message?.trim();
  if (message) {
    if (message.length > 300) throw new CodexProError("Stash message is limited to 300 characters.");
    args.push("-m", message);
  }
  if (options.paths?.length) args.push("--", ...safePaths(guard, workspace, options.paths));
  const stdout = runGitChecked(config, workspace, args);
  return actionResult(config, workspace, "stash_push", stdout);
}

export function gitRestore(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { paths: string[]; mode: "unstage" | "discard_worktree" | "discard_all"; confirmed?: boolean }
): GitActionResult {
  const paths = safePaths(guard, workspace, options.paths);
  if (options.mode !== "unstage" && !options.confirmed) {
    throw new CodexProError("Discarding working-tree changes requires confirm=true after reviewing the exact paths.");
  }
  const args = ["restore"];
  if (options.mode === "unstage") args.push("--staged");
  if (options.mode === "discard_worktree") args.push("--worktree");
  if (options.mode === "discard_all") args.push("--source=HEAD", "--staged", "--worktree");
  args.push("--", ...paths);
  const stdout = runGitChecked(config, workspace, args);
  return actionResult(config, workspace, `restore_${options.mode}`, stdout);
}

export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. Writes are allowed and review tools surface diffs.
  return;
}
