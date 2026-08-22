import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { CodexProError } from "./guard.js";
import { serverAdminPath } from "./localPaths.js";

export const RELOADABLE_SERVICES = ["codexpro", "ngrok", "dashboard"] as const;
export type ReloadableService = (typeof RELOADABLE_SERVICES)[number];

const LAUNCHCTL = "/bin/launchctl";
const PYTHON3 = "/usr/bin/python3";
const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
const SERVICE_LABELS: Record<ReloadableService, string> = {
  codexpro: process.env.CODEXPRO_SERVICE_LABEL?.trim() || "com.dogfood.codexpro.bridge",
  ngrok: process.env.CODEXPRO_NGROK_SERVICE_LABEL?.trim() || "com.dogfood.codexpro-ngrok",
  dashboard: process.env.CODEXPRO_DASHBOARD_SERVICE_LABEL?.trim() || "com.dogfood.macmini.dashboard"
};

function isReloadableService(value: string): value is ReloadableService {
  return (RELOADABLE_SERVICES as readonly string[]).includes(value);
}

function codexProReloadHelper(): string {
  return process.env.CODEXPRO_RELOAD_HELPER?.trim() || serverAdminPath("scripts", "reload-codexpro-bridge-once.py");
}

function scheduleCodexProReload(): { service: ReloadableService; status: string } {
  const helper = codexProReloadHelper();
  if (!existsSync(helper)) {
    throw new CodexProError(
      `CodexPro self-reload helper is unavailable at ${helper}. Set CODEXPRO_RELOAD_HELPER to a fixed detached reload helper.`
    );
  }
  const child = spawn(PYTHON3, [helper], {
    detached: true,
    stdio: "ignore"
  });
  if (!child.pid) {
    throw new CodexProError("Failed to schedule the CodexPro self-reload helper.");
  }
  child.unref();
  return { service: "codexpro", status: "scheduled" };
}

export function launchdStatus(service: ReloadableService): "active" | "scheduled" | "unavailable" {
  const result = spawnSync(LAUNCHCTL, ["print", `${domain}/${SERVICE_LABELS[service]}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return "unavailable";
  return /active count = [1-9]/.test(result.stdout) ? "active" : "scheduled";
}

export function reloadWhitelistedService(serviceInput: string): { service: ReloadableService; status: string } {
  if (!isReloadableService(serviceInput)) {
    throw new CodexProError("service must be one of: codexpro, ngrok, dashboard.");
  }
  const service = serviceInput;
  if (service === "codexpro") return scheduleCodexProReload();

  const result = spawnSync(LAUNCHCTL, ["kickstart", "-k", `${domain}/${SERVICE_LABELS[service]}`], {
    stdio: "ignore"
  });
  return { service, status: result.status === 0 ? launchdStatus(service) : "failed" };
}
