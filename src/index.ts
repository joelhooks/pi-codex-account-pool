import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stream as builtinStream, streamSimple as builtinStreamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { loginOpenAICodex, refreshOpenAICodexToken, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { enrollOAuthCredential, freshCredential, saveEnrollment } from "./auth.js";
import { FallbackCredentialStore, FileCredentialStore, MacOSKeychainCredentialStore } from "./credential-store.js";
import { readMetadata, writeMetadata } from "./metadata.js";
import { streamSimpleWithPool } from "./stream-pool.js";
import { CODEX_API, PROVIDER_ID } from "./types.js";

const POOL_DIR = join(homedir(), ".pi", "codex-account-pool");
const METADATA_PATH = join(POOL_DIR, "metadata.json");
const CREDENTIALS_DIR = join(POOL_DIR, "credentials");

export default function codexAccountPool(pi: ExtensionAPI): void {
  const credentials = new FallbackCredentialStore(
    new MacOSKeychainCredentialStore(),
    new FileCredentialStore(CREDENTIALS_DIR),
  );
  const readPool = () => readMetadata(METADATA_PATH);
  const writePool = (metadata: Awaited<ReturnType<typeof readPool>>) => writeMetadata(METADATA_PATH, metadata);

  // Override only the built-in API stream. Registering an existing provider via
  // ExtensionAPI leaves Pi 0.80.6 non-interactive processes alive after output.
  // The API registry replacement preserves Pi's native provider identity/model
  // catalog, which Codex tool-call IDs require, and scopes pooling to openai-codex.
  registerApiProvider({
    api: CODEX_API,
    stream: builtinStream,
    streamSimple: (model, context, options) => model.provider === PROVIDER_ID
      ? streamSimpleWithPool(model as never, context, options, {
          credentials,
          metadata: readPool,
          writeMetadata: writePool,
          delegate: builtinStreamSimple,
          resolveCredential: (profile) => freshCredential(profile.id, credentials, refreshOpenAICodexToken),
        })
      : builtinStreamSimple(model as never, context, options),
  }, "pi-codex-account-pool");

  pi.registerCommand("codex-pool-status", {
    description: "Show Codex account pool profiles and reset state",
    handler: async (_args, ctx) => {
      const metadata = await readPool();
      ctx.ui.notify(formatStatus(metadata), "info");
      setPoolStatus(ctx, metadata);
    },
  });

  pi.registerCommand("codex-pool-import-current", {
    description: "Import Pi's current OpenAI Codex login into the pool",
    handler: async (args, ctx) => {
      try {
        const result = await importCurrentPiLogin(ctx, await readPool(), args.trim() || undefined);
        await saveEnrollment(result, credentials, writePool);
        ctx.ui.notify(`Imported ${result.profile.label} into the Codex pool`, "info");
        setPoolStatus(ctx, result.metadata);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("codex-pool-add", {
    description: "Add another Codex subscription account: /codex-pool-add email@example.com",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/codex-pool-add requires interactive UI", "error");
        return;
      }
      const expectedEmail = args.trim() || await ctx.ui.input("Account email to add", "name@example.com");
      if (!expectedEmail) return;

      try {
        let metadata = await readPool();
        // Preserve the account Pi already uses before the new OAuth login replaces
        // anything. This reads the in-memory AuthStorage and never rewrites auth.json.
        const native = currentPiOAuth(ctx);
        if (native) {
          const imported = enrollOAuthCredential(metadata, native);
          await saveEnrollment(imported, credentials, writePool);
          metadata = imported.metadata;
        }

        ctx.ui.notify(`Opening OpenAI login for ${expectedEmail}. Choose that exact account in the browser.`, "info");
        const oauth = await loginOpenAICodex({
          onAuth: ({ url }) => {
            void openUrl(url).catch(() => {
              ctx.ui.notify(`Could not open the browser automatically. Open this one-time URL:\n${url}`, "warning");
            });
          },
          onPrompt: async ({ message, placeholder }) => {
            const value = await ctx.ui.input(message, placeholder);
            if (!value) throw new Error("Login cancelled");
            return value;
          },
          onProgress: (message) => ctx.ui.setStatus("codex-pool-auth", message),
          originator: "pi-codex-account-pool",
        });
        const enrolled = enrollOAuthCredential(metadata, oauth, expectedEmail);
        await saveEnrollment(enrolled, credentials, writePool);
        ctx.ui.setStatus("codex-pool-auth", undefined);
        ctx.ui.notify(`Added ${enrolled.profile.label}. Pool now has ${enrolled.metadata.profiles.length} accounts.`, "info");
        setPoolStatus(ctx, enrolled.metadata);
      } catch (error) {
        ctx.ui.setStatus("codex-pool-auth", undefined);
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("codex-pool-refresh", {
    description: "Refresh local Codex pool metadata timestamp (quota wiring follows auth)",
    handler: async (_args, ctx) => {
      const metadata = await readPool();
      const updated = { ...metadata, updatedAt: new Date().toISOString() };
      await writePool(updated);
      setPoolStatus(ctx, updated);
      ctx.ui.notify(`Codex pool metadata refreshed (${metadata.profiles.length} profiles)`, "info");
    },
  });
}

export function currentPiOAuth(ctx: Pick<ExtensionCommandContext, "modelRegistry">): OAuthCredentials | undefined {
  const credential = ctx.modelRegistry.authStorage.get(PROVIDER_ID);
  if (!credential || credential.type !== "oauth") return undefined;
  const { type: _type, ...oauth } = credential;
  return oauth;
}

export function importCurrentPiLogin(
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
  metadata: Awaited<ReturnType<typeof readMetadata>>,
  expectedEmail?: string,
) {
  const oauth = currentPiOAuth(ctx);
  if (!oauth) throw new Error("Pi has no current OpenAI Codex OAuth login to import");
  return enrollOAuthCredential(metadata, oauth, expectedEmail);
}

function setPoolStatus(ctx: Pick<ExtensionCommandContext, "ui">, metadata: Awaited<ReturnType<typeof readMetadata>>): void {
  const active = metadata.profiles.find((profile) => profile.id === metadata.activeProfileId);
  ctx.ui.setStatus("codex-pool", active ? `codex: ${active.label} (${metadata.profiles.length})` : `codex: ${metadata.profiles.length} account(s)`);
}

function formatStatus(metadata: Awaited<ReturnType<typeof readMetadata>>): string {
  if (metadata.profiles.length === 0) return "Codex pool is empty. Run /codex-pool-add <email>.";
  return [
    `Codex pool: ${metadata.profiles.length} account(s)`,
    ...metadata.profiles.map((profile) => {
      const active = profile.id === metadata.activeProfileId ? "●" : "○";
      const exhaustion = profile.exhaustedUntil ? ` · exhausted until ${profile.exhaustedUntil}` : "";
      return `${active} ${profile.label}${exhaustion}`;
    }),
  ].join("\n");
}

function openUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("open", [url], { shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`open exited with code ${code}`)));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export * from "./auth.js";
export * from "./credential-store.js";
export * from "./errors.js";
export * from "./jwt.js";
export * from "./machine.js";
export * from "./metadata.js";
export * from "./quota.js";
export * from "./selection.js";
export * from "./stream-pool.js";
export * from "./types.js";
