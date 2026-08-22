import fs from "node:fs/promises";
import path from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { CodexProError } from "./guard.js";
import { codexDir } from "./localPaths.js";
import { redactSensitiveText } from "./redact.js";

const SERVER_NAME = "baidu_netdisk";
const ACTIONS = ["get_quota", "file_list", "file_keyword_search", "file_semantics_search"] as const;
export type ReadAction = (typeof ACTIONS)[number];
const MAX_OUTPUT_BYTES = 40_000;

function bounded(value: unknown): string {
  const raw = redactSensitiveText(JSON.stringify(value));
  if (Buffer.byteLength(raw, "utf8") <= MAX_OUTPUT_BYTES) return raw;
  return `${Buffer.from(raw, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n...[output truncated]`;
}

function safeInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function safeText(value: unknown, fallback = "", max = 200): string {
  const text = String(value ?? fallback).trim();
  if (text.length > max) throw new CodexProError(`argument exceeds ${max} characters.`);
  return text;
}

function normalizeArgs(action: ReadAction, input: Record<string, unknown>): Record<string, unknown> {
  if (action === "get_quota") return {};
  const dir = safeText(input.dir, "/", 500);
  if (dir.includes("..")) throw new CodexProError("dir cannot contain parent traversal.");
  if (action === "file_list") return { dir, page: safeInt(input.page, 1, 1000) };
  if (action === "file_keyword_search") return { dir, key: safeText(input.key ?? input.keyword, "", 200), num: safeInt(input.num, 20, 100), page: safeInt(input.page, 1, 1000) };
  return {
    category: safeText(input.category, "", 50),
    dir,
    file_ext: safeText(input.file_ext, "", 50),
    num: safeInt(input.num, 20, 100),
    query: safeText(input.query, "", 300),
    search_type: safeText(input.search_type, "", 50),
    sources: safeText(input.sources, "", 100),
    stream: Boolean(input.stream ?? false)
  };
}

async function loadServerCommand(): Promise<{ command: string; args: string[] }> {
  const config = await fs.readFile(path.join(codexDir(), "config.toml"), "utf8");
  const start = config.indexOf("[mcp_servers.baidu_netdisk]");
  if (start < 0) throw new CodexProError("baidu_netdisk MCP configuration is missing.");
  const section = config.slice(start, config.indexOf("\n[", start + 2) < 0 ? undefined : config.indexOf("\n[", start + 2));
  const command = section.match(/^command\s*=\s*"([^"]+)"/m)?.[1];
  const argsText = section.match(/^args\s*=\s*(\[[^\n]+\])/m)?.[1];
  if (!command || !argsText) throw new CodexProError("baidu_netdisk MCP transport configuration is incomplete.");
  const args = JSON.parse(argsText);
  if (!Array.isArray(args) || args.some((x) => typeof x !== "string")) throw new CodexProError("baidu_netdisk MCP transport arguments are invalid.");
  return { command, args };
}

export async function callBaiduRead(actionInput: string, input: Record<string, unknown>): Promise<{ action: ReadAction; server: string; arguments: Record<string, unknown>; result: string }> {
  if (!(ACTIONS as readonly string[]).includes(actionInput)) throw new CodexProError("Only the four baidu_netdisk read actions are allowed.");
  const action = actionInput as ReadAction;
  const args = normalizeArgs(action, input);
  const transportConfig = await loadServerCommand();
  const client = new Client({ name: "codexpro-baidu-read", version: "1.0.0" });
  const transport = new StdioClientTransport({ ...transportConfig, stderr: "ignore" });
  try {
    await client.connect(transport);
    const available = (await client.listTools()).tools.map((tool) => tool.name);
    if (!available.includes(action)) throw new CodexProError(`The approved baidu_netdisk action is unavailable: ${action}.`);
    const result = await client.callTool({ name: action, arguments: args });
    return { action, server: SERVER_NAME, arguments: args, result: bounded(result) };
  } catch (error) {
    if (error instanceof CodexProError) throw error;
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "transport";
    throw new CodexProError(`baidu_netdisk read call failed (${code}).`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export { ACTIONS as BAIDU_READ_ACTIONS };
