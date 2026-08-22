import fs from "node:fs/promises";
import path from "node:path";
import { serverAdminPath } from "./localPaths.js";

export const POLICY_PATH = process.env.CODEXPRO_MODEL_POLICY_PATH?.trim() || serverAdminPath("config", "codex-model-policy.json");
export const USAGE_DIR = process.env.CODEXPRO_USAGE_DIR?.trim() || serverAdminPath("state", "codex-usage");
export const USAGE_PATH = path.join(USAGE_DIR, "usage.jsonl");
export const RATE_CARD_PATH = path.join(USAGE_DIR, "rate-card.json");

export type Profile = "economy" | "balanced" | "power";
export type RequestedProfile = "auto" | Profile;
export interface ModelPolicy { profiles: Record<Profile, { model: string }>; default_profile: RequestedProfile; default_max_profile: Profile; }
export interface UsageRecord { timestamp: string; task_id: string; model_used: string | null; profile_requested: RequestedProfile; profile_used: Profile; fallback_count: number; duration_ms: number; input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; credits: number | null; credit_source: string; accuracy: "exact" | "estimated" | "unknown"; }

const ORDER: Profile[] = ["economy", "balanced", "power"];

export async function loadModelPolicy(): Promise<ModelPolicy> {
  try { return JSON.parse(await fs.readFile(POLICY_PATH, "utf8")) as ModelPolicy; }
  catch { return { profiles: { economy: { model: "gpt-5.6-luna" }, balanced: { model: "gpt-5.6-terra" }, power: { model: "gpt-5.6-sol" } }, default_profile: "auto", default_max_profile: "balanced" }; }
}

export function capProfile(profile: Profile, max: Profile): Profile { return ORDER[Math.min(ORDER.indexOf(profile), ORDER.indexOf(max))]; }
export function chooseProfile(task: string, requested: RequestedProfile, max: Profile): Profile {
  if (requested !== "auto") return capProfile(requested, max);
  const complex = /architecture|refactor|大型|架构|疑难|复杂|security review|多文件|multi-file/i.test(task) || task.length > 5000;
  return capProfile(complex ? "balanced" : "economy", max);
}

export async function recordUsage(record: UsageRecord): Promise<void> {
  await fs.mkdir(USAGE_DIR, { recursive: true, mode: 0o700 });
  await fs.appendFile(USAGE_PATH, JSON.stringify(record) + "\n", { mode: 0o600 });
}

export async function readUsage(action: "last" | "session" | "today" | "summary"): Promise<unknown> {
  let text = ""; try { text = await fs.readFile(USAGE_PATH, "utf8"); } catch { return { records: [] }; }
  const records = text.split(/\n/).filter(Boolean).slice(-100).map((line) => JSON.parse(line) as UsageRecord);
  if (action === "last") return records.at(-1) ?? null;
  if (action === "session") return { records: records.slice(-10) };
  const day = new Date().toISOString().slice(0, 10);
  const today = records.filter((r) => r.timestamp.startsWith(day));
  return { count: today.length, total_credits: today.reduce((n, r) => n + (r.credits ?? 0), 0), records: action === "today" ? today : today.slice(-10) };
}
