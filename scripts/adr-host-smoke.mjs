import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdrHostOrchestrator } from '../dist/adrHostOps.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-adr-host-smoke-'));
const stateRoot = path.join(root, 'state');
const workspaceRoot = path.join(root, 'workspace');
const fakeAdr = path.join(root, 'fake-adr');
const fakeLog = path.join(root, 'fake-adr.log');
await fs.mkdir(workspaceRoot, { recursive: true });
await fs.writeFile(fakeAdr, `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nif(process.env.CODEXPRO_TOOL_SURFACE||process.env.CODEBASE_BRIDGE_MODE){process.stderr.write('host control env leaked');process.exit(3);}\nfs.appendFileSync(process.env.ADR_FAKE_LOG, JSON.stringify(args)+'\\n');\nif(args[0]==='host-begin'){process.stdout.write(JSON.stringify({schemaVersion:1,command:'host-begin',status:'tracked',sessionId:'chg.fake'}));process.exit(0);}\nif(args[0]==='host-complete'){process.stdout.write(JSON.stringify({schemaVersion:1,command:'host-complete',status:'converged',presentation:{visibility:'show',impact:'assurance',slot:'completion',text:'ADR ✓ fake convergence'}}));process.exit(0);}\nprocess.stderr.write('unexpected fake ADR command');process.exit(2);\n`, { mode: 0o755 });
await fs.chmod(fakeAdr, 0o755);

const workspace = {
  id: 'ws_0123456789abcdef01234567',
  root: workspaceRoot,
  openedAt: new Date().toISOString()
};
const options = {
  adrBin: fakeAdr,
  stateRoot,
  env: {
    ADR_FAKE_LOG: fakeLog,
    CODEXPRO_TOOL_SURFACE: 'stable',
    CODEBASE_BRIDGE_MODE: 'legacy-host-control'
  }
};
const first = new AdrHostOrchestrator(options);
const begin = await first.beforeMutation(workspace, { tool: 'edit', paths: ['src/example.ts'] });
if (begin.status !== 'tracked') throw new Error(`expected tracked begin, got ${begin.status}`);
if (!(await first.active(workspace))) throw new Error('tracked session was not persisted');

// Simulate a fresh MCP server object/process lifecycle reading the same persisted state.
const second = new AdrHostOrchestrator(options);
const repeated = await second.beforeMutation(workspace, { tool: 'write', paths: ['src/other.ts'] });
if (repeated.status !== 'existing') throw new Error(`expected persisted existing session, got ${repeated.status}`);
const completion = await second.complete(workspace);
if (completion.status !== 'completed' || completion.outcome !== 'converged') {
  throw new Error(`unexpected completion: ${JSON.stringify(completion)}`);
}
if (completion.presentation?.visibility !== 'show' || !completion.presentation.text.includes('fake convergence')) {
  throw new Error('completion presentation was not preserved');
}
if (await second.active(workspace)) throw new Error('completed session was not removed from persisted host state');

const invocations = (await fs.readFile(fakeLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
if (invocations.filter((args) => args[0] === 'host-begin').length !== 1) throw new Error('duplicate host-begin was issued across orchestrator instances');
if (invocations.filter((args) => args[0] === 'host-complete').length !== 1) throw new Error('expected exactly one host-complete');

const unavailable = new AdrHostOrchestrator({ adrBin: path.join(root, 'missing-adr'), stateRoot: path.join(root, 'unavailable-state') });
const unavailableResult = await unavailable.beforeMutation(workspace, { tool: 'edit' });
if (unavailableResult.status !== 'unavailable') throw new Error('missing ADR binary should degrade to unavailable without throwing');

await fs.rm(root, { recursive: true, force: true });
console.log('adr-host-smoke: ok');
