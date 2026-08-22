import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { PathGuard, WorkspaceManager } from '../dist/guard.js';
import {
  gitCommit,
  gitCreateBranch,
  gitMerge,
  gitRestore,
  gitStage,
  gitStageHunks,
  gitStash,
  gitSwitch
} from '../dist/gitOps.js';
import { finishWorkUnit, readWorkUnit, startWorkUnit } from '../dist/workUnitOps.js';
import { verifyChangedJs } from '../dist/verifyOps.js';

function git(root, args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function firstHunkOnly(diff) {
  const hunks = [...diff.matchAll(/^@@\s/gm)].map((match) => match.index);
  if (hunks.length < 2) throw new Error(`expected two diff hunks:\n${diff}`);
  return `${diff.slice(0, hunks[0])}${diff.slice(hunks[0], hunks[1])}`;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-git-tools-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.com']);
  git(root, ['config', 'user.name', 'Smoke Test']);

  const demo = Array.from({ length: 24 }, (_, index) => `console.log(${index + 1});`).join('\n') + '\n';
  await fs.writeFile(path.join(root, 'demo.js'), demo, 'utf8');
  await fs.writeFile(path.join(root, 'allowed.js'), 'const allowed = 1;\n', 'utf8');
  await fs.writeFile(path.join(root, 'dirty.js'), 'const dirty = 1;\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);

  const previousRoot = process.env.CODEXPRO_ROOT;
  const previousAllowed = process.env.CODEXPRO_ALLOWED_ROOTS;
  process.env.CODEXPRO_ROOT = root;
  process.env.CODEXPRO_ALLOWED_ROOTS = root;
  const config = loadConfig(['--root', root, '--allow-root', root, '--bash', 'full', '--write', 'workspace', '--tool-mode', 'full']);
  if (previousRoot === undefined) delete process.env.CODEXPRO_ROOT; else process.env.CODEXPRO_ROOT = previousRoot;
  if (previousAllowed === undefined) delete process.env.CODEXPRO_ALLOWED_ROOTS; else process.env.CODEXPRO_ALLOWED_ROOTS = previousAllowed;

  const workspaces = new WorkspaceManager(config);
  const workspace = workspaces.openWorkspace(root);
  const guard = new PathGuard(config);

  gitCreateBranch(config, workspace, 'feature/native-git');
  if (git(root, ['branch', '--show-current']).trim() !== 'feature/native-git') throw new Error('git_create_branch did not switch branches');
  gitSwitch(config, workspace, 'main');

  const lines = demo.trimEnd().split('\n');
  lines[1] = 'console.log("first-hunk");';
  lines[20] = 'console.log("second-hunk");';
  await fs.writeFile(path.join(root, 'demo.js'), `${lines.join('\n')}\n`, 'utf8');
  const patch = firstHunkOnly(git(root, ['diff', '--unified=1', '--', 'demo.js']));
  gitStageHunks(config, guard, workspace, patch);
  const staged = git(root, ['diff', '--cached', '--', 'demo.js']);
  const unstaged = git(root, ['diff', '--', 'demo.js']);
  if (!staged.includes('first-hunk') || staged.includes('second-hunk')) throw new Error(`partial stage was wrong:\n${staged}`);
  if (!unstaged.includes('second-hunk')) throw new Error(`second hunk disappeared from working tree:\n${unstaged}`);
  gitCommit(config, workspace, 'stage selected hunk');

  gitStash(config, guard, workspace, { action: 'push', message: 'remaining hunk' });
  if (!gitStash(config, guard, workspace, { action: 'list' }).stdout.includes('remaining hunk')) throw new Error('stash list missing pushed stash');
  gitStash(config, guard, workspace, { action: 'pop' });
  if (!git(root, ['diff', '--', 'demo.js']).includes('second-hunk')) throw new Error('stash pop did not restore remaining hunk');

  let refusedDiscard = false;
  try {
    gitRestore(config, guard, workspace, { paths: ['demo.js'], mode: 'discard_worktree', confirmed: false });
  } catch {
    refusedDiscard = true;
  }
  if (!refusedDiscard) throw new Error('destructive restore did not require confirmation');
  gitRestore(config, guard, workspace, { paths: ['demo.js'], mode: 'discard_worktree', confirmed: true });

  gitCreateBranch(config, workspace, 'feature/merge-check');
  await fs.writeFile(path.join(root, 'merge.js'), 'export const merged = true;\n', 'utf8');
  gitStage(config, guard, workspace, ['merge.js']);
  gitCommit(config, workspace, 'add merge file');
  gitSwitch(config, workspace, 'main');
  gitMerge(config, workspace, 'feature/merge-check');
  await fs.stat(path.join(root, 'merge.js'));

  await fs.writeFile(path.join(root, 'dirty.js'), 'const dirty = 2;\n', 'utf8');
  const unit = startWorkUnit(config, workspace, { title: 'scope audit', allowedPaths: ['allowed.js'] });
  await fs.writeFile(path.join(root, 'allowed.js'), 'const allowed = 2;\n', 'utf8');
  await fs.writeFile(path.join(root, 'dirty.js'), 'const dirty = 3;\n', 'utf8');
  await fs.writeFile(path.join(root, 'outside.js'), 'const outside = true;\n', 'utf8');
  const finish = finishWorkUnit(workspace, unit.id);
  if (!finish.baseline_paths_changed_again.includes('dirty.js')) throw new Error(`work unit missed changed pre-existing dirty file: ${JSON.stringify(finish)}`);
  if (!finish.out_of_scope_paths.includes('dirty.js') || !finish.out_of_scope_paths.includes('outside.js')) throw new Error(`work unit missed out-of-scope paths: ${JSON.stringify(finish)}`);
  if (!finish.newly_touched_paths.includes('outside.js')) throw new Error(`work unit missed new path: ${JSON.stringify(finish)}`);
  let finishedRecordStillExists = false;
  try {
    readWorkUnit(unit.id);
    finishedRecordStillExists = true;
  } catch {
    // Expected: finished work units are removed from runtime state.
  }
  if (finishedRecordStillExists) throw new Error('finished work unit runtime state was not cleaned up');

  const verifyOk = verifyChangedJs(config, guard, workspace);
  if (verifyOk.failed !== 0 || !verifyOk.checked.some((item) => item.path === 'allowed.js')) throw new Error(`verify_changed_js failed valid files: ${JSON.stringify(verifyOk)}`);
  await fs.writeFile(path.join(root, 'broken.js'), 'const = ;\n', 'utf8');
  const verifyBroken = verifyChangedJs(config, guard, workspace);
  if (!verifyBroken.checked.some((item) => item.path === 'broken.js' && !item.ok)) throw new Error(`verify_changed_js missed broken syntax: ${JSON.stringify(verifyBroken)}`);

  console.log('git/work-unit/verify smoke ok');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
