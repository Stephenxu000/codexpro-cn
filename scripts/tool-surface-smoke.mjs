import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
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
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-tool-surface-'));
const client = new McpStdioClient(
  process.execPath,
  ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'full', '--tool-mode', 'full'],
  {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: tmp,
      CODEXPRO_ALLOWED_ROOTS: tmp,
      CODEXPRO_BASH_MODE: 'full',
      CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_TOOL_SURFACE: 'stable'
    }
  }
);

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-tool-surface-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const listed = await client.request('tools/list', {});
  const direct = listed.tools.map((tool) => tool.name).sort();
  const requiredDirect = [
    'codexpro',
    'server_config',
    'open_current_workspace',
    'open_workspace',
    'tree',
    'search',
    'read',
    'write',
    'edit',
    'apply_patch',
    'bash',
    'git_status',
    'git_diff',
    'git_switch',
    'git_create_branch',
    'git_stage',
    'git_stage_hunks',
    'git_commit',
    'git_merge',
    'git_stash',
    'git_restore',
    'show_changes'
  ];
  for (const name of requiredDirect) {
    if (!direct.includes(name)) throw new Error(`stable surface missing direct tool: ${name}`);
  }

  const hiddenActions = [
    'list_workspaces',
    'skill_search',
    'work_unit_start',
    'verify_changed_js',
    'task_submit',
    'agent_run',
    'mcp_read_call',
    'codexpro_self_test'
  ];
  for (const name of hiddenActions) {
    if (direct.includes(name)) throw new Error(`stable surface unexpectedly exposed low-frequency tool: ${name}`);
  }

  const config = await client.request('tools/call', { name: 'server_config', arguments: {} });
  if (config.isError) throw new Error('server_config failed on stable surface');
  if (config.structuredContent.toolSurface !== 'stable') throw new Error('server_config did not report stable surface');
  if (config.structuredContent.toolSchemaVersion !== 3) throw new Error('unexpected tool schema version');
  if (!/^[a-f0-9]{16}$/.test(String(config.structuredContent.capabilityFingerprint || ''))) {
    throw new Error('missing capability fingerprint');
  }
  if (!(config.structuredContent.availableActionCount > config.structuredContent.registeredToolCount)) {
    throw new Error('stable surface did not retain hidden wrapped actions');
  }

  const actions = await client.request('tools/call', {
    name: 'codexpro',
    arguments: { action: 'list_actions' }
  });
  if (actions.isError) throw new Error('codexpro list_actions failed');
  for (const name of hiddenActions) {
    if (!actions.structuredContent.actions.includes(name)) throw new Error(`wrapper lost enabled action: ${name}`);
  }
  if (actions.structuredContent.direct_tools.includes('list_workspaces')) {
    throw new Error('wrapper reported hidden list_workspaces as direct');
  }

  const wrapped = await client.request('tools/call', {
    name: 'codexpro',
    arguments: { action: 'list_workspaces', args: {} }
  });
  if (wrapped.isError) throw new Error('hidden list_workspaces action was not callable through codexpro');
  if (wrapped.structuredContent.wrapped_tool !== 'list_workspaces') {
    throw new Error('wrapped action did not identify list_workspaces');
  }

  console.log(`tool surface smoke ok: ${direct.length} direct tools, ${actions.structuredContent.action_count} wrapped actions`);
} finally {
  client.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
