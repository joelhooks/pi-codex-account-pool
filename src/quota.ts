import { isoFromReset } from "./errors.js";
import type { UsageSnapshot, UsageWindow } from "./types.js";

export interface QuotaClientOptions {
  fetch?: typeof fetch;
  now?: () => Date;
}

export class QuotaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  constructor(options: QuotaClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }
  async getUsage(accessToken: string, accountId: string): Promise<UsageSnapshot> {
    const response = await this.fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, "chatgpt-account-id": accountId },
    });
    if (!response.ok) throw new Error(`usage refresh failed: ${response.status}`);
    return parseUsagePayload(await response.json(), this.now());
  }
}

export function parseUsagePayload(payload: unknown, now = new Date()): UsageSnapshot {
  const obj = asRecord(payload) ?? {};
  const rateLimit = unwrapObject(obj.rate_limit) ?? unwrapObject(obj.rateLimit) ?? obj;
  const resetCredits = asRecord(obj.rate_limit_reset_credits) ?? asRecord(obj.rateLimitResetCredits);
  const primary = parseWindow(rateLimit.primary_window ?? rateLimit.primaryWindow ?? obj.primary ?? obj.primary_window);
  const secondary = parseWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow ?? obj.secondary ?? obj.secondary_window);
  return {
    plan: str(obj.plan_type) ?? str(obj.planType) ?? str(obj.plan) ?? str(obj.account_plan),
    primary,
    secondary,
    creditsRemaining: num(resetCredits?.available_count) ?? num(resetCredits?.availableCount) ?? num(obj.reset_credits) ?? num(obj.reset_credit_count) ?? num(obj.credits_remaining),
    creditsResetAt: isoFromReset(resetCredits?.resets_at ?? resetCredits?.reset_at ?? resetCredits?.resetAt ?? obj.reset_credits_reset_at ?? obj.credits_reset_at),
    fetchedAt: now.toISOString(),
  };
}

function parseWindow(value: unknown): UsageWindow | undefined {
  const obj = unwrapObject(value);
  if (!obj) return undefined;
  return {
    usedPercent: num(obj.used_percent) ?? num(obj.usedPercent) ?? num(obj.percent_used),
    resetAt: isoFromReset(obj.reset_at ?? obj.resetAt ?? obj.resets_at),
    windowSeconds: num(obj.limit_window_seconds) ?? num(obj.limitWindowSeconds) ?? num(obj.window_seconds) ?? num(obj.windowSeconds),
  };
}

function unwrapObject(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return undefined;
  const obj = asRecord(value);
  if (!obj) return undefined;
  if ("Some" in obj) return unwrapObject(obj.Some);
  return obj;
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function str(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function num(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
