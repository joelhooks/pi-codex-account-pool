import type { ErrorClassification } from "./types.js";

export function classifyProviderError(value: unknown): ErrorClassification {
  const status = extractStatus(value);
  const data = extractData(value);
  const error = isRecord(data?.error) ? data.error : isRecord(data) ? data : undefined;
  const type = stringValue(error?.type) ?? stringValue((value as { type?: unknown })?.type);
  const resetsAt = isoFromReset(error?.resets_at ?? data?.resets_at);
  if (type === "usage_limit_reached" && resetsAt) {
    return { type, resetsAt, planType: stringValue(error?.plan_type) ?? stringValue(data?.plan_type), rawMessage: stringValue(error?.message) };
  }
  return { type: "generic", status, message: extractMessage(value) };
}

export function isUsageLimitError(value: unknown): value is { type: "usage_limit_reached"; resetsAt: string } {
  return classifyProviderError(value).type === "usage_limit_reached";
}

export function isoFromReset(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return epochToIso(numeric);
  }
  if (typeof value === "number" && Number.isFinite(value)) return epochToIso(value);
  return undefined;
}

function epochToIso(value: number): string | undefined {
  const millis = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function extractStatus(value: unknown): number | undefined {
  if (isRecord(value) && typeof value.status === "number") return value.status;
  if (isRecord(value) && typeof value.statusCode === "number") return value.statusCode;
  return undefined;
}

function extractData(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const parsed = tryJson(value);
    return isRecord(parsed) ? parsed : undefined;
  }
  if (isRecord(value)) {
    if (isRecord(value.data)) return value.data;
    if (isRecord(value.response) && isRecord(value.response.data)) return value.response.data;
    if (typeof value.message === "string") {
      const parsed = tryJson(value.message);
      if (isRecord(parsed)) return parsed;
    }
    return value;
  }
  return undefined;
}

function extractMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.message === "string" ? value.message : undefined;
}

function tryJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
