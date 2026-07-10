import type { PoolMetadata, PoolProfile, ProfileId, UsageLimitResult } from "./types.js";

export function isProfileEligible(profile: PoolProfile, now = new Date()): boolean {
  if (!profile.exhaustedUntil) return true;
  return Date.parse(profile.exhaustedUntil) <= now.getTime();
}

export function selectProfile(metadata: PoolMetadata, now = new Date()): PoolProfile | undefined {
  const active = metadata.activeProfileId ? metadata.profiles.find((p) => p.id === metadata.activeProfileId) : undefined;
  if (active && isProfileEligible(active, now)) return active;
  const pinned = metadata.profiles.find((p) => p.pinned && isProfileEligible(p, now));
  if (pinned) return pinned;
  return metadata.profiles.find((p) => isProfileEligible(p, now));
}

export function selectAlternateProfile(metadata: PoolMetadata, currentId: ProfileId, now = new Date()): PoolProfile | undefined {
  return metadata.profiles.find((p) => p.id !== currentId && isProfileEligible(p, now));
}

export function markUsageLimit(metadata: PoolMetadata, profileId: ProfileId, limit: UsageLimitResult, now = new Date()): PoolMetadata {
  return {
    ...metadata,
    activeProfileId: metadata.activeProfileId === profileId ? undefined : metadata.activeProfileId,
    updatedAt: now.toISOString(),
    profiles: metadata.profiles.map((p) => p.id === profileId ? { ...p, exhaustedUntil: limit.resetsAt } : p),
  };
}

export function expireResets(metadata: PoolMetadata, now = new Date()): PoolMetadata {
  return {
    ...metadata,
    profiles: metadata.profiles.map((p) => p.exhaustedUntil && Date.parse(p.exhaustedUntil) <= now.getTime() ? { ...p, exhaustedUntil: undefined } : p),
  };
}
