import { spawnSync } from "node:child_process";
import { CodexProError } from "./guard.js";

export const RELOADABLE_SERVICES = ["ngrok", "dashboard"] as const;
export type ReloadableService = (typeof RELOADABLE_SERVICES)[number];

const LAUNCHCTL = "/bin/launchctl";
const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
const SERVICE_LABELS: Record<ReloadableService, string> = {
  ngrok: process.env.CODEXPRO_NGROK_SERVICE_LABEL?.trim() || "com.dogfood.codexpro-ngrok",
  dashboard: process.env.CODEXPRO_DASHBOARD_SERVICE_LABEL?.trim() || "com.dogfood.macmini.dashboard"
};

function isReloadableService(value: string): value is ReloadableService {
  return (RELOADABLE_SERVICES as readonly string[]).includes(value);
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
    throw new CodexProError("service must be one of: ngrok, dashboard.");
  }
  const service = serviceInput;
  const result = spawnSync(LAUNCHCTL, ["kickstart", "-k", `${domain}/${SERVICE_LABELS[service]}`], {
    stdio: "ignore"
  });
  return { service, status: result.status === 0 ? launchdStatus(service) : "failed" };
}
