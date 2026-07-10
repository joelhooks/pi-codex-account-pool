import { createHash } from "node:crypto";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { decodeJwtIdentity } from "./jwt.js";
import type { CredentialStore, PoolMetadata, PoolProfile, StoredCredential } from "./types.js";

export interface EnrollmentResult {
  credential: StoredCredential;
  metadata: PoolMetadata;
  profile: PoolProfile;
}

export type OAuthRefresher = (refreshToken: string) => Promise<OAuthCredentials>;

const refreshes = new Map<string, Promise<StoredCredential>>();

export function enrollOAuthCredential(
  metadata: PoolMetadata,
  oauth: OAuthCredentials,
  expectedEmail?: string,
  now = new Date(),
): EnrollmentResult {
  const identity = decodeJwtIdentity(oauth.access);
  const email = identity.email?.trim().toLowerCase();
  const expected = expectedEmail?.trim().toLowerCase();
  const accountId = identity.accountId ?? stringValue(oauth.accountId);

  if (expected && !email) {
    throw new Error(`Authenticated account did not expose an email; refusing to add it as ${expected}`);
  }
  if (expected && email !== expected) {
    throw new Error(`Authenticated as ${email}, expected ${expected}; nothing was saved`);
  }
  if (!accountId && !email) {
    throw new Error("Authenticated account did not expose an account id or email");
  }

  const id = profileId(accountId ?? email!);
  const existing = metadata.profiles.find((profile) => profile.id === id || (email && profile.email?.toLowerCase() === email));
  const profile: PoolProfile = {
    ...existing,
    id: existing?.id ?? id,
    label: email ?? identity.label,
    ...(email ? { email } : {}),
    ...(accountId ? { accountId } : {}),
  };
  const profiles = existing
    ? metadata.profiles.map((candidate) => candidate.id === existing.id ? profile : candidate)
    : [...metadata.profiles, profile];

  return {
    credential: toStoredCredential(oauth),
    profile,
    metadata: {
      ...metadata,
      activeProfileId: metadata.activeProfileId ?? profile.id,
      profiles,
      updatedAt: now.toISOString(),
    },
  };
}

export async function saveEnrollment(
  result: EnrollmentResult,
  credentials: CredentialStore,
  writeMetadata: (metadata: PoolMetadata) => Promise<void>,
): Promise<void> {
  const previous = await credentials.get(result.profile.id);
  await credentials.set(result.profile.id, result.credential);
  try {
    await writeMetadata(result.metadata);
  } catch (error) {
    if (previous) await credentials.set(result.profile.id, previous);
    else await credentials.delete(result.profile.id);
    throw error;
  }
}

export async function freshCredential(
  profileId: string,
  credentials: CredentialStore,
  refresh: OAuthRefresher,
  now = Date.now(),
  leewayMs = 60_000,
): Promise<StoredCredential | undefined> {
  const current = await credentials.get(profileId);
  if (!current || !needsRefresh(current, now, leewayMs)) return current;
  if (!current.refreshToken) throw new Error(`Credential for ${profileId} expired without a refresh token`);

  const inFlight = refreshes.get(profileId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    // Re-read after entering the in-process single-flight. Another request may
    // already have rotated the refresh token while this one was waiting.
    const latest = await credentials.get(profileId);
    if (!latest || !needsRefresh(latest, Date.now(), leewayMs)) return latest ?? current;
    if (!latest.refreshToken) throw new Error(`Credential for ${profileId} expired without a refresh token`);
    const refreshed = toStoredCredential(await refresh(latest.refreshToken));
    await credentials.set(profileId, refreshed);
    return refreshed;
  })().finally(() => refreshes.delete(profileId));

  refreshes.set(profileId, promise);
  return promise;
}

export function needsRefresh(credential: StoredCredential, now = Date.now(), leewayMs = 60_000): boolean {
  return typeof credential.expiresAt === "number" && credential.expiresAt <= now + leewayMs;
}

export function toStoredCredential(oauth: OAuthCredentials): StoredCredential {
  return {
    accessToken: oauth.access,
    refreshToken: oauth.refresh,
    expiresAt: oauth.expires,
  };
}

function profileId(subject: string): string {
  return `codex-${createHash("sha256").update(subject).digest("hex").slice(0, 16)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
