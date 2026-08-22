import os from "node:os";
import path from "node:path";

function envPath(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? path.resolve(value) : fallback;
}

export function codexDir(): string {
  return envPath("CODEXPRO_CODEX_DIR", path.join(os.homedir(), ".codex"));
}

export function serverAdminRoot(): string {
  return envPath("CODEXPRO_SERVER_ADMIN_ROOT", path.join(os.homedir(), "ServerAdmin"));
}

export function serverAdminPath(...parts: string[]): string {
  return path.join(serverAdminRoot(), ...parts);
}
