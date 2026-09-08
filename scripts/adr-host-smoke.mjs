import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdrHostOrchestrator, decorateAdrHostMutationResult } from '../dist/adrHostOps.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-adr-host-smoke-'));
const stateRoot = path.join(root, 'state');
const workspaceRoot = path.join(root, 'workspace');
const fakeAdr = path.join(root, 'fake-adr');
const fakeLog = path.join(root, 'fake-adr.log');
await fs.mkdir(workspaceRoot, { recursive: true });
await fs.writeFile(fakeAdr, `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nif(process.env.CODEXPRO_TOOL_SURFACE||process.env.CODEBASE_BRIDGE_MODE){process.stderr.write('host control env leaked');process.exit(3);}\nfs.appendFileSync(process.env.ADR_FAKE_LOG, JSON.stringify(args)+'\\n');\nif(args[0]==='host-begin'){process.stdout.write(JSON.stringify({schemaVersion:1,command:'host-begin',status:'tracked',sessionId:'chg.fake',modelContext:'# ADR Project Context\\n\\n- preserve the trusted boundary'}));process.exit(0);}\nif(args[0]==='host-complete'&&args.includes('chg.missing')){process.stderr.write("Error: ENOENT: no such file or directory, open '/brain/changes/chg.missing/host-session.json'");process.exit(1);}\nif(args[0]==='host-complete'){process.stdout.write(JSON.stringify({schemaVersion:1,command:'host-complete',status:'converged',presentation:{visibility:'show',impact:'assurance',slot:'completion',text:'ADR ✓ fake convergence'}}));process.exit(0);}\nprocess.stderr.write('unexpected fake ADR command');process.exit(2);\n`, { mode: 0o755 });
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
if (!begin.modelContext?.includes('trusted boundary')) throw new Error('host-begin modelContext was not preserved');
const decoratedMutation = decorateAdrHostMutationResult({ content: [{ type: 'text', text: 'edit complete' }], structuredContent: {} }, begin);
const mutationText = decoratedMutation.content?.find((item) => item.type === 'text')?.text ?? '';
if (!mutationText.includes('show_changes') || !mutationText.includes('trusted boundary')) throw new Error('mutation result did not inject ADR context/completion hint');
if (decoratedMutation.structuredContent?.adr_host?.context_injected !== true) throw new Error('mutation structured content did not report ADR context injection');
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

// A long-idle tracked session must be cancelled before a new mutation starts a fresh session.
const staleHost = new AdrHostOrchestrator({ ...options, staleSessionMs: 60_000 });
const staleBegin = await staleHost.beforeMutation(workspace, { tool: 'edit', paths: ['src/stale.ts'] });
if (staleBegin.status !== 'tracked') throw new Error('failed to create stale-session fixture');
const statePath = path.join(stateRoot, 'adr-host-sessions.json');
const staleState = JSON.parse(await fs.readFile(statePath, 'utf8'));
staleState.sessions[workspace.id].lastMutationAt = '2000-01-01T00:00:00.000Z';
await fs.writeFile(statePath, `${JSON.stringify(staleState, null, 2)}\n`, 'utf8');
const recovered = await staleHost.beforeMutation(workspace, { tool: 'write', paths: ['src/fresh.ts'] });
if (recovered.status !== 'tracked') throw new Error(`stale recovery did not start a fresh tracked session: ${JSON.stringify(recovered)}`);
await staleHost.complete(workspace);

// A stale local session whose ADR host sidecar is already gone is an orphan, not a reason to mutate Git refs.
const orphanState = JSON.parse(await fs.readFile(statePath, 'utf8'));
orphanState.sessions[workspace.id] = {
  workspaceId: workspace.id,
  root: workspace.root,
  sessionId: 'chg.missing',
  startedAt: '2000-01-01T00:00:00.000Z',
  lastMutationAt: '2000-01-01T00:00:00.000Z'
};
await fs.writeFile(statePath, `${JSON.stringify(orphanState, null, 2)}\n`, 'utf8');
const orphanRecovered = await staleHost.beforeMutation(workspace, { tool: 'edit', paths: ['src/after-orphan.ts'] });
if (orphanRecovered.status !== 'tracked' || orphanRecovered.recoveredOrphan !== true) {
  throw new Error(`orphan recovery did not start a transparent fresh session: ${JSON.stringify(orphanRecovered)}`);
}
const orphanDecorated = decorateAdrHostMutationResult({ content: [{ type: 'text', text: 'edit complete' }], structuredContent: {} }, orphanRecovered);
if (orphanDecorated.structuredContent?.adr_host?.recovered_orphan !== true) throw new Error('orphan recovery was not surfaced to the model');
if (!String(orphanDecorated.content?.[0]?.text ?? '').includes('未验证历史')) throw new Error('orphan recovery did not warn about unverified prior work');
await staleHost.complete(workspace);

const invocations = (await fs.readFile(fakeLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
if (invocations.filter((args) => args[0] === 'host-begin').length !== 4) throw new Error('unexpected host-begin count across normal + stale/orphan recovery flows');
if (invocations.filter((args) => args[0] === 'host-complete').length !== 5) throw new Error('unexpected host-complete count across normal + stale/orphan recovery flows');
if (!invocations.some((args) => args[0] === 'host-complete' && args.includes('cancelled'))) throw new Error('stale recovery did not cancel the abandoned session');
if (!invocations.some((args) => args[0] === 'host-complete' && args.includes('chg.missing'))) throw new Error('orphan recovery did not detect the missing ADR sidecar');

const unavailable = new AdrHostOrchestrator({ adrBin: path.join(root, 'missing-adr'), stateRoot: path.join(root, 'unavailable-state') });
const unavailableResult = await unavailable.beforeMutation(workspace, { tool: 'edit' });
if (unavailableResult.status !== 'unavailable') throw new Error('missing ADR binary should degrade to unavailable without throwing');

await fs.rm(root, { recursive: true, force: true });
console.log('adr-host-smoke: ok');
