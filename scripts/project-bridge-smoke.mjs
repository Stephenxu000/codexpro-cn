import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const allowed = new Set([
  "project_status", "project_overview", "verify_project",
  "tree", "search", "read", "write", "edit", "apply_patch",
  "git_status", "git_diff", "show_changes", "git_stage", "git_stage_hunks",
  "git_commit", "git_push"
]);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("no port")));
    });
    server.on("error", reject);
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-project-bridge-"));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-project-bridge-home-"));
await fs.writeFile(path.join(root, "marker.txt"), "project bridge\n");
const port = await freePort();
const authEmail = "bridge-smoke@example.test";
const authKey = "[REDACTED_SECRET]";
const child = spawn("node", ["dist/http.js"], {
  cwd: path.resolve("."),
  env: {
    ...process.env,
    HOME: home,
    CODEXPRO_HOME: home,
    CODEXPRO_ROOT: root,
    CODEXPRO_HOST: "127.0.0.1",
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_EMAIL: authEmail,
    CODEXPRO_HTTP_KEY: authKey,
    CODEXPRO_PROJECT_BRIDGE: "1",
    CODEXPRO_PROJECT_BRIDGE_CHECKS: "node --version",
    CODEXPRO_BASH_MODE: "off",
    CODEXPRO_WRITE_MODE: "workspace",
    CODEXPRO_TOOL_MODE: "full",
    CODEXPRO_TOOL_CARDS: "0"
  },
  stdio: ["ignore", "ignore", "pipe"]
});

let stderr = "";
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server timeout\n" + stderr)), 15000);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("HTTP MCP listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error("server exited " + code + "\n" + stderr)));
  });
  const rejectedHealth = await fetch("http://127.0.0.1:" + port + "/healthz");
  if (rejectedHealth.status !== 401) throw new Error("project bridge accepted unauthenticated HTTP");
  const authorizedHealth = await fetch("http://127.0.0.1:" + port + "/healthz", {
    headers: { "X-MCP-Email": authEmail, "X-MCP-Key": authKey }
  });
  if (!authorizedHealth.ok) throw new Error("human credential auth failed: " + authorizedHealth.status);
  const client = new Client({ name: "project-bridge-smoke", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:" + port + "/mcp"),
    { requestInit: { headers: { "X-MCP-Email": authEmail, "X-MCP-Key": authKey } } }
  ));
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const name of names) {
    if (!allowed.has(name)) throw new Error("unexpected project bridge tool: " + name);
  }
  for (const name of ["project_status", "project_overview", "verify_project", "read", "edit", "git_commit", "git_push"]) {
    if (!names.has(name)) throw new Error("missing project bridge tool: " + name);
  }
  const projectStatus = await client.callTool({ name: "project_status", arguments: {} });
  if (projectStatus.isError || !JSON.stringify(projectStatus).includes("Workspace:")) throw new Error("project_status did not return human-readable status");
  const verified = await client.callTool({ name: "verify_project", arguments: {} });
  if (verified.isError) throw new Error("verify_project failed");
  for (const forbidden of ["open_workspace", "bash", "server_config", "reload_service", "run_check", "git_switch", "git_create_branch", "work_unit_start"]) {
    if (names.has(forbidden)) throw new Error("forbidden project bridge tool exposed: " + forbidden);
  }
  await client.close();
  console.log("project bridge smoke ok: " + names.size + " scoped tools");
} finally {
  child.kill("SIGTERM");
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
}
