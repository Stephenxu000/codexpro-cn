#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  process.stderr.write("project-bridge: " + message + "\n");
  process.exit(1);
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" }
  });
  if (result.error || result.status !== 0) {
    fail((result.stderr || result.stdout || result.error?.message || "git failed").trim());
  }
  return (result.stdout || "").trim();
}

const repo = path.resolve(process.env.CODEXPRO_PROJECT_REPO || process.argv[2] || "");
const actor = String(process.env.CODEXPRO_PROJECT_ACTOR || process.argv[3] || "").trim();
if (!repo || !fs.existsSync(repo)) fail("CODEXPRO_PROJECT_REPO or repo argument is required.");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(actor)) fail("actor must be 1-64 safe characters.");

const branchPrefix = String(process.env.CODEXPRO_PROJECT_BRANCH_PREFIX || "ai/").trim();
if (!/^[A-Za-z0-9._/-]+$/.test(branchPrefix) || branchPrefix.includes("..")) fail("invalid branch prefix.");
const branch = branchPrefix + actor;
const worktreeRoot = path.resolve(
  process.env.CODEXPRO_PROJECT_WORKTREE_ROOT ||
  path.join(path.dirname(repo), ".project-dev-bridge", path.basename(repo))
);
const worktree = path.join(worktreeRoot, actor);

git(repo, ["rev-parse", "--is-inside-work-tree"]);
fs.mkdirSync(worktreeRoot, { recursive: true });

if (!fs.existsSync(worktree)) {
  const branchExists = spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/" + branch], { cwd: repo }).status === 0;
  git(repo, branchExists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, "HEAD"]);
}

const actualBranch = git(worktree, ["branch", "--show-current"]);
if (actualBranch !== branch) fail("existing worktree branch mismatch: expected " + branch + ", got " + actualBranch);

if (process.env.CODEXPRO_PROJECT_PREPARE_ONLY === "1") {
  process.stdout.write(JSON.stringify({ repo, actor, branch, worktree }) + "\n");
  process.exit(0);
}

const child = spawn(process.execPath, [path.resolve("dist/http.js")], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    CODEXPRO_ROOT: worktree,
    CODEXPRO_ALLOWED_ROOTS: worktree,
    CODEXPRO_PROJECT_BRIDGE: "1",
    CODEXPRO_BASH_MODE: "off",
    CODEXPRO_WRITE_MODE: "workspace",
    CODEXPRO_TOOL_MODE: "full",
    CODEXPRO_TOOL_CARDS: "0"
  },
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
