import assert from 'node:assert/strict';
import { bashCommandMayHaveSideEffects } from '../dist/bashOps.js';

assert.equal(bashCommandMayHaveSideEffects('git status'), false);
assert.equal(bashCommandMayHaveSideEffects('git status | head -20'), false);
assert.equal(
  bashCommandMayHaveSideEffects("git worktree list --porcelain && printf '\\n--- refs ---\\n' && git log --oneline --decorate --graph --all -n 8"),
  false
);
assert.equal(bashCommandMayHaveSideEffects('npm test'), false);
assert.equal(bashCommandMayHaveSideEffects('touch scratch.txt'), true);
assert.equal(bashCommandMayHaveSideEffects('echo hi > scratch.txt'), true);
assert.equal(bashCommandMayHaveSideEffects('git reset --hard HEAD~1'), true);
assert.equal(bashCommandMayHaveSideEffects('curl https://example.com'), true);

console.log('adr-bash-classification-smoke: ok');
