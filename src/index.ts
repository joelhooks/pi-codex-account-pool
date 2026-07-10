import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple as builtinStreamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { homedir } from "node:os";
import { join } from "node:path";
import { MacOSKeychainCredentialStore } from "./credential-store.js";
import { readMetadata, writeMetadata } from "./metadata.js";
import { streamSimpleWithPool } from "./stream-pool.js";
import { PROVIDER_ID } from "./types.js";

const METADATA_PATH = join(homedir(), ".pi", "codex-account-pool", "metadata.json");

export default function codexAccountPool(pi: ExtensionAPI): void {
  const credentials = new MacOSKeychainCredentialStore();

  // Override the existing provider rather than inventing a synthetic one. The
  // built-in model metadata and provider identity must survive so Codex tool-call
  // IDs continue round-tripping correctly across turns.
  pi.registerProvider(PROVIDER_ID, {
    apiKey: "pool-managed-by-keychain",
    streamSimple: (model, context, options) => streamSimpleWithPool(model as never, context, options, {
      credentials,
      metadata: () => readMetadata(METADATA_PATH),
      writeMetadata: (metadata) => writeMetadata(METADATA_PATH, metadata),
      delegate: builtinStreamSimple,
    }),
  });

  pi.registerCommand("codex-pool-status", {
    description: "Show the local Codex account pool status",
    handler: async (_args, ctx) => {
      const metadata = await readMetadata(METADATA_PATH);
      const active = metadata.profiles.find((p) => p.id === metadata.activeProfileId);
      const text = active ? `codex pool: ${active.label}` : `codex pool: ${metadata.profiles.length} profile(s), none active`;
      ctx.ui.setStatus("codex-pool", text);
    },
  });

  pi.registerCommand("codex-pool-refresh", {
    description: "Refresh local Codex pool status from metadata only (live quota wiring is next slice)",
    handler: async (_args, ctx) => {
      const metadata = await readMetadata(METADATA_PATH);
      await writeMetadata(METADATA_PATH, { ...metadata, updatedAt: new Date().toISOString() });
      ctx.ui.setStatus("codex-pool", `codex pool: metadata refreshed (${metadata.profiles.length} profile(s))`);
    },
  });
}

export * from "./credential-store.js";
export * from "./errors.js";
export * from "./jwt.js";
export * from "./machine.js";
export * from "./metadata.js";
export * from "./quota.js";
export * from "./selection.js";
export * from "./stream-pool.js";
export * from "./types.js";
