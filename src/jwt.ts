export interface JwtIdentity {
  email?: string;
  accountId?: string;
  label: string;
}

function decodePart(part: string): unknown {
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

export function decodeJwtIdentity(jwt: string | undefined): JwtIdentity {
  if (!jwt) return { label: "Codex account" };
  const parts = jwt.split(".");
  if (parts.length < 2) return { label: "Codex account" };
  try {
    const claims = decodePart(parts[1]) as Record<string, unknown>;
    const auth = objectValue(claims["https://api.openai.com/auth"]);
    const profile = objectValue(claims["https://api.openai.com/profile"]);
    const email = firstString(claims, ["email"]) ?? firstString(profile, ["email"]);
    const accountId = firstString(claims, ["https://api.openai.com/auth/account_id", "account_id", "chatgpt_account_id", "org_id"])
      ?? firstString(auth, ["account_id", "chatgpt_account_id", "org_id"]);
    return { email, accountId, label: email ?? (accountId ? `Codex ${accountId.slice(0, 6)}` : "Codex account") };
  } catch {
    return { label: "Codex account" };
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function firstString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
