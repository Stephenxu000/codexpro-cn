import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

class Client {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }
  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (!msg.id || !this.pending.has(msg.id)) continue;
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }
  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  close() { this.child.kill('SIGTERM'); }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-adr-host-server-'));
const workspace = path.join(root, 'workspace');
const stateRoot = path.join(root, 'state');
const fakeAdr = path.join(root, 'fake-adr');
const logPath = path.join(root, 'fake.log');
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(path.join(workspace, 'demo.txt'), 'before\n', 'utf8');
await fs.writeFile(fakeAdr, `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(process.env.ADR_FAKE_LOG,JSON.stringify(args)+'\\n');\nif(args[0]==='host-begin'){process.stdout.write(JSON.stringify({status:'tracked',sessionId:'chg.server-smoke'}));process.exit(0)}\nif(args[0]==='host-complete'){process.stdout.write(JSON.stringify({status:'converged',presentation:{visibility:'show',impact:'assurance',slot:'completion',text:'ADR ✓ host lifecycle smoke'}}));process.exit(0)}\nprocess.exit(2)\n`, { mode: 0o755 });
await fs.chmod(fakeAdr, 0o755);

const env = {
  ...process.env,
  ADR_BIN: fakeAdr,
  ADR_FAKE_LOG: logPath,
  CODEXPRO_ADR_HOST_STATE_DIR: stateRoot,
  CODEXPRO_ROOT: workspace,
  CODEXPRO_ALLOWED_ROOTS: workspace,
  CODEXPRO_TOOL_MODE: 'full',
  CODEXPRO_TOOL_SURFACE: 'stable'
};
const client = new Client(process.execPath, ['dist/stdio.js', '--root', workspace, '--allow-root', workspace, '--write', 'workspace', '--tool-mode', 'full'], { cwd: path.resolve('.'), env });
try {
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'adr-host-server-smoke', version: '1' } });
  client.notify('notifications/initialized');
  const opened = await client.request('tools/call', { name: 'open_workspace', arguments: { root: workspace, include_tree: false } });
  const workspaceId = opened.structuredContent.workspace_id;
  const edited = await client.request('tools/call', { name: 'edit', arguments: { workspace_id: workspaceId, path: 'demo.txt', old_text: 'before', new_text: 'after' } });
  if (edited.isError) throw new Error(`edit failed: ${JSON.stringify(edited)}`);
  const stateAfterEdit = JSON.parse(await fs.readFile(path.join(stateRoot, 'adr-host-sessions.json'), 'utf8'));
  if (!stateAfterEdit.sessions?.[workspaceId]) throw new Error('edit did not persist an ADR host session');

  const reviewed = await client.request('tools/call', { name: 'show_changes', arguments: { workspace_id: workspaceId, include_diff: false } });
  if (reviewed.isError) throw new Error(`show_changes failed: ${JSON.stringify(reviewed)}`);
  if (reviewed.structuredContent.adr_host?.outcome !== 'converged') throw new Error('show_changes did not receive ADR completion outcome');
  if (reviewed.structuredContent.adr_host?.presentation?.visibility !== 'show') throw new Error('show_changes did not expose ADR presentation');
  const text = reviewed.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!text.includes('ADR ✓ host lifecycle smoke')) throw new Error('ADR presentation was not appended to the normal tool text');
  const stateAfterReview = JSON.parse(await fs.readFile(path.join(stateRoot, 'adr-host-sessions.json'), 'utf8'));
  if (stateAfterReview.sessions?.[workspaceId]) throw new Error('show_changes did not clear the completed host session');

  const calls = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  if (calls.filter((args) => args[0] === 'host-begin').length !== 1) throw new Error('expected one automatic host-begin');
  if (calls.filter((args) => args[0] === 'host-complete').length !== 1) throw new Error('expected one automatic host-complete');
  console.log('adr-host-server-smoke: ok');
} finally {
  client.close();
  await fs.rm(root, { recursive: true, force: true });
}
