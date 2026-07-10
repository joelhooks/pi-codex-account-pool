export const PROVIDER_ID = "openai-codex";
export const MODEL_ID = "gpt-5.6-sol";
export const CODEX_API = "openai-codex-responses";

export type ProfileId = string;

export interface PoolProfile {
  id: ProfileId;
  label: string;
  email?: string;
  accountId?: string;
  pinned?: boolean;
  exhaustedUntil?: string;
  lastUsage?: UsageSnapshot;
}

export interface PoolMetadata {
  version: 1;
  activeProfileId?: ProfileId;
  profiles: PoolProfile[];
  updatedAt: string;
}

export interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface CredentialStore {
  get(profileId: ProfileId): Promise<StoredCredential | undefined>;
  set(profileId: ProfileId, credential: StoredCredential): Promise<void>;
  delete(profileId: ProfileId): Promise<void>;
}

export interface UsageWindow {
  usedPercent?: number;
  resetAt?: string;
  windowSeconds?: number;
}

export interface UsageSnapshot {
  plan?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  creditsRemaining?: number;
  creditsResetAt?: string;
  fetchedAt: string;
}

export interface UsageLimitResult {
  type: "usage_limit_reached";
  resetsAt: string;
  planType?: string;
  rawMessage?: string;
}

export type ErrorClassification = UsageLimitResult | { type: "generic"; status?: number; message?: string };
