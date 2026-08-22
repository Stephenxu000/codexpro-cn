import fs from "node:fs/promises";
import path from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { CodexProError } from "./guard.js";
import { codexDir } from "./localPaths.js";
import { redactSensitiveText } from "./redact.js";

const SERVER_NAME = "baidu_netdisk";
const ACTIONS = ["make_dir", "file_move", "file_rename"] as const;
export type OrganizeAction = (typeof ACTIONS)[number];
const MAX_OUTPUT_BYTES = 40_000;
const MAX_BATCH_ITEMS = 20;

export interface OrganizeItem {
  path: string;
  dest: string;
  newname: string;
}

function bounded(value: unknown): string {
  const raw = redactSensitiveText(JSON.stringify(value));
  if (Buffer.byteLength(raw, "utf8") <= MAX_OUTPUT_BYTES) return raw;
  return `${Buffer.from(raw, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n...[output truncated]`;
}

function safeText(value: unknown, label: string, max = 1000): string {
  const text = String(value ?? "").trim();
  if (!text) throw new CodexProError(`${label} is required.`);
  if (text.length > max) throw new CodexProError(`${label} exceeds ${max} characters.`);
  if (/\p{Cc}/u.test(text)) throw new CodexProError(`${label} cannot contain control characters.`);
  return text;
}

function safeAbsolutePath(value: unknown, label: string): string {
  const text = safeText(value, label);
  if (!text.startsWith("/")) throw new CodexProError(`${label} must be an absolute Baidu path.`);
  if (text === "/") throw new CodexProError(`${label} cannot be the Baidu root.`);
  const parts = text.split("/");
  if (parts.some((part) => part === "..")) throw new CodexProError(`${label} cannot contain parent traversal.`);
  return text.replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

function safeNewName(value: unknown): string {
  const text = safeText(value, "newname", 255);
  if (text === "." || text === "..") throw new CodexProError("newname is invalid.");
  if (text.includes("/") || text.includes("\\")) throw new CodexProError("newname must be a single file or directory name.");
  return text;
}

function normalizeItems(value: unknown): OrganizeItem[] {
  if (!Array.isArray(value) || value.length === 0) throw new CodexProError("items must be a non-empty array.");
  if (value.length > MAX_BATCH_ITEMS) throw new CodexProError(`A single organize call supports at most ${MAX_BATCH_ITEMS} items.`);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CodexProError(`items[${index}] must be an object.`);
    const item = raw as Record<string, unknown>;
    const source = safeAbsolutePath(item.path, `items[${index}].path`);
    const dest = safeAbsolutePath(item.dest, `items[${index}].dest`);
    const newname = safeNewName(item.newname);
    if (dest === source || dest.startsWith(`${source}/`)) throw new CodexProError(`items[${index}] cannot move a path into itself.`);
    return { path: source, dest, newname };
  });
}

async function loadServerCommand(): Promise<{ command: string; args: string[] }> {
  const config = await fs.readFile(path.join(codexDir(), "config.toml"), "utf8");
  const start = config.indexOf("[mcp_servers.baidu_netdisk]");
  if (start < 0) throw new CodexProError("baidu_netdisk MCP configuration is missing.");
  const next = config.indexOf("\n[", start + 2);
  const section = config.slice(start, next < 0 ? undefined : next);
  const command = section.match(/^command\s*=\s*"([^"]+)"/m)?.[1];
  const argsText = section.match(/^args\s*=\s*(\[[^\n]+\])/m)?.[1];
  if (!command || !argsText) throw new CodexProError("baidu_netdisk MCP transport configuration is incomplete.");
  const args = JSON.parse(argsText);
  if (!Array.isArray(args) || args.some((x) => typeof x !== "string")) throw new CodexProError("baidu_netdisk MCP transport arguments are invalid.");
  return { command, args };
}

export async function callBaiduOrganize(
  actionInput: string,
  input: Record<string, unknown>
): Promise<{ action: OrganizeAction; server: string; arguments: Record<string, unknown>; result: string }> {
  if (!(ACTIONS as readonly string[]).includes(actionInput)) {
    throw new CodexProError("Only make_dir, file_move, and file_rename are allowed for Baidu organization writes.");
  }
  const action = actionInput as OrganizeAction;
  let args: Record<string, unknown>;
  if (action === "make_dir") {
    const path = safeAbsolutePath(input.path, "path");
    // The official MCP handles request encoding internally; pass the logical absolute path here.
    args = { path, rtype: "0" };
  } else {
    const items = normalizeItems(input.items);
    args = { async: 0, filelist: JSON.stringify(items), ondup: "fail" };
  }

  const transportConfig = await loadServerCommand();
  const client = new Client({ name: "codexpro-baidu-organize", version: "1.0.0" });
  const transport = new StdioClientTransport({ ...transportConfig, stderr: "ignore" });
  try {
    await client.connect(transport);
    const available = (await client.listTools()).tools.map((tool) => tool.name);
    if (!available.includes(action)) throw new CodexProError(`The approved baidu_netdisk organize action is unavailable: ${action}.`);
    const result = await client.callTool({ name: action, arguments: args });
    return { action, server: SERVER_NAME, arguments: args, result: bounded(result) };
  } catch (error) {
    if (error instanceof CodexProError) throw error;
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "transport";
    const detail = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 800);
    throw new CodexProError(`baidu_netdisk organize call failed (${code}): ${detail}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export { ACTIONS as BAIDU_ORGANIZE_ACTIONS };
