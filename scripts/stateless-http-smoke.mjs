import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

function waitForListening(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for stateless canary\n${stderr}`)), timeoutMs);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`stateless canary exited before listening: code=${code} signal=${signal}\n${stderr}`));
    });
  });
}

function stopServer(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timeout stopping stateless canary'));
    }, timeoutMs);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function startServer({ root, alternateRoot, home, port }) {
  return spawn('node', ['dist/http.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      CODEXPRO_HOME: home,
      CODEXPRO_ROOT: root,
      CODEXPRO_ALLOWED_ROOTS: [root, alternateRoot].join(path.delimiter),
      CODEXPRO_HOST: '127.0.0.1',
      CODEXPRO_PORT: String(port),
      CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1',
      CODEXPRO_BASH_MODE: 'off',
      CODEXPRO_WRITE_MODE: 'off',
      CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_TOOL_CARDS: '0',
      CODEXPRO_CODEX_SESSIONS: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
    throw new Error(`${name} failed: ${text}`);
  }
  return result;
}

function resultText(result) {
  return result.content?.find?.((part) => part.type === 'text')?.text ?? '';
}

async function createLegacyClient(endpoint, name, headers = undefined) {
  const client = new Client({ name, version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: headers ? { headers } : undefined
  });
  await client.connect(transport);
  return { client, transport };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stateless-default-'));
const alternateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stateless-alternate-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stateless-home-'));
const port = await getFreePort();
const endpoint = `http://127.0.0.1:${port}/mcp`;

await fs.writeFile(path.join(root, 'marker.txt'), 'default workspace\n', 'utf8');
await fs.writeFile(path.join(alternateRoot, 'marker.txt'), 'alternate workspace\n', 'utf8');

let child;
let first;
let second;
try {
  child = startServer({ root, alternateRoot, home, port });
  await waitForListening(child);

  first = await createLegacyClient(endpoint, 'codexpro-stateless-smoke-a');
  if (first.transport.sessionId != null) {
    throw new Error(`stateless transport unexpectedly received session id ${first.transport.sessionId}`);
  }

  const healthBefore = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  if (
    healthBefore.transportMode !== 'stateless' ||
    !healthBefore.serverEpoch ||
    !healthBefore.startedAt ||
    healthBefore.toolSchemaVersion !== 4 ||
    healthBefore.toolSurface !== 'expanded' ||
    !/^[a-f0-9]{16}$/.test(String(healthBefore.capabilityFingerprint || '')) ||
    !(healthBefore.availableActionCount + 1 >= healthBefore.directToolCount)
  ) {
    throw new Error(`stateless health metadata missing: ${JSON.stringify(healthBefore)}`);
  }

  const tools = await first.client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const required of ['open_workspace', 'read', 'list_workspaces']) {
    if (!names.has(required)) throw new Error(`stateless legacy client missing required tool ${required}`);
  }

  const stale = await createLegacyClient(endpoint, 'codexpro-stateless-stale-header', { 'Mcp-Session-Id': 'legacy-session-that-no-longer-exists' });
  try {
    const staleTools = await stale.client.listTools();
    if (!staleTools.tools.some((tool) => tool.name === 'read')) {
      throw new Error('stale legacy Mcp-Session-Id header was not ignored by stateless /mcp');
    }
  } finally {
    await stale.client.close();
  }

  const alternate = await callTool(first.client, 'open_workspace', { root: alternateRoot, include_tree: false });
  const alternateId = alternate.structuredContent?.workspace_id;
  if (!alternateId) throw new Error('open_workspace did not return workspace_id');

  const implicit = await callTool(first.client, 'read', { path: 'marker.txt' });
  if (!resultText(implicit).includes('default workspace')) {
    throw new Error(`omitted workspace_id did not resolve to configured default workspace: ${resultText(implicit)}`);
  }

  const explicitAlternate = await callTool(first.client, 'read', { workspace_id: alternateId, path: 'marker.txt' });
  if (!resultText(explicitAlternate).includes('alternate workspace')) {
    throw new Error(`explicit alternate workspace_id was not honored: ${resultText(explicitAlternate)}`);
  }

  second = await createLegacyClient(endpoint, 'codexpro-stateless-smoke-b');
  const secondImplicit = await callTool(second.client, 'read', { path: 'marker.txt' });
  if (!resultText(secondImplicit).includes('default workspace')) {
    throw new Error('second stateless client inherited another client workspace state');
  }
  const secondExplicit = await callTool(second.client, 'read', { workspace_id: alternateId, path: 'marker.txt' });
  if (!resultText(secondExplicit).includes('alternate workspace')) {
    throw new Error('second stateless client could not resolve explicit persisted workspace_id');
  }

  await stopServer(child);
  child = startServer({ root, alternateRoot, home, port });
  await waitForListening(child);

  const healthAfter = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  if (healthAfter.serverEpoch === healthBefore.serverEpoch || healthAfter.transportMode !== 'stateless') {
    throw new Error(`server epoch did not change across restart: ${JSON.stringify({ before: healthBefore, after: healthAfter })}`);
  }

  const toolsAfterRestart = await first.client.listTools();
  if (!toolsAfterRestart.tools.some((tool) => tool.name === 'read')) {
    throw new Error('same legacy client could not call stateless endpoint after bridge restart');
  }
  if (first.transport.sessionId != null) {
    throw new Error(`session id appeared after restart: ${first.transport.sessionId}`);
  }

  const explicitAfterRestart = await callTool(first.client, 'read', { workspace_id: alternateId, path: 'marker.txt' });
  if (!resultText(explicitAfterRestart).includes('alternate workspace')) {
    throw new Error('explicit workspace_id did not survive stateless bridge restart');
  }

  const implicitAfterRestart = await callTool(first.client, 'read', { path: 'marker.txt' });
  if (!resultText(implicitAfterRestart).includes('default workspace')) {
    throw new Error('default workspace fallback changed after stateless bridge restart');
  }

  console.log(`stateless HTTP smoke ok: ${tools.tools.length} tools, legacy client survived restart without Mcp-Session-Id`);
} finally {
  await first?.client.close().catch(() => {});
  await second?.client.close().catch(() => {});
  await stopServer(child).catch(() => {});
  await Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(alternateRoot, { recursive: true, force: true }),
    fs.rm(home, { recursive: true, force: true })
  ]);
}
