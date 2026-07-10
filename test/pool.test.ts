import { createAssistantMessageEventStream, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { enrollOAuthCredential, freshCredential, saveEnrollment } from "../src/auth.js";
import { FallbackCredentialStore, FileCredentialStore, InMemoryCredentialStore, MacOSKeychainCredentialStore } from "../src/credential-store.js";
import codexAccountPool from "../src/index.js";
import { classifyProviderError } from "../src/errors.js";
import { decodeJwtIdentity } from "../src/jwt.js";
import { metadataMode, writeMetadata } from "../src/metadata.js";
import { parseUsagePayload } from "../src/quota.js";
import { expireResets, selectProfile } from "../src/selection.js";
import { streamSimpleWithPool, type CodexDelegate } from "../src/stream-pool.js";
import type { PoolMetadata } from "../src/types.js";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 372000,
  maxTokens: 128000,
};

const usageLimit = (epochSeconds = 1_800_000_000) => ({
  status: 400,
  data: { error: { type: "usage_limit_reached", resets_at: epochSeconds, plan_type: "plus" } },
});

function metadata(): PoolMetadata {
  return {
    version: 1,
    activeProfileId: "a",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profiles: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  };
}

function delegateEvents(events: AssistantMessageEvent[]): CodexDelegate {
  return () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      for (const event of events) stream.push(event);
      stream.end();
    });
    return stream;
  };
}

function delegateThrow(error: unknown, calls: unknown[]): CodexDelegate {
  return (_model, _context, options) => {
    calls.push(options);
    throw error;
  };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
  const out: AssistantMessageEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function start(): AssistantMessageEvent { return { type: "start", partial: partial() }; }
function textDelta(delta: string): AssistantMessageEvent { return { type: "text_delta", contentIndex: 0, delta, partial: partial() }; }
function done(): AssistantMessageEvent { return { type: "done", reason: "stop", message: partial("stop") }; }
function errorEvent(message: string): AssistantMessageEvent { return { type: "error", reason: "error", error: { ...partial("error"), errorMessage: message } }; }
function partial(stopReason: "stop" | "error" = "stop") {
  return { role: "assistant" as const, content: [], api: "openai-codex-responses" as const, provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: 0 };
}

function jwt(payload: object) {
  const enc = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.`;
}

describe("extension registration", () => {
  it("wraps the built-in provider without replacing its model catalog", () => {
    const commands: string[] = [];
    codexAccountPool({
      registerCommand: (name: string) => commands.push(name),
    } as unknown as ExtensionAPI);

    expect(getApiProvider("openai-codex-responses")?.streamSimple).toBeTypeOf("function");
    expect(commands).toEqual([
      "codex-pool-status",
      "codex-pool-import-current",
      "codex-pool-add",
      "codex-pool-refresh",
    ]);
  });
});

describe("selection", () => {
  it("keeps active pin until reset expiry, then makes expired profile eligible", () => {
    const meta = metadata();
    meta.activeProfileId = undefined;
    meta.profiles[0]!.pinned = true;
    expect(selectProfile(meta, new Date("2026-01-01T00:00:00.000Z"))?.id).toBe("a");
    meta.profiles[0]!.exhaustedUntil = "2026-01-02T00:00:00.000Z";
    expect(selectProfile(meta, new Date("2026-01-01T00:00:00.000Z"))?.id).toBe("b");
    expect(selectProfile(expireResets(meta, new Date("2026-01-03T00:00:00.000Z")), new Date("2026-01-03T00:00:00.000Z"))?.id).toBe("a");
  });
});

describe("error classification", () => {
  it("accepts exact usage_limit_reached with numeric resets_at", () => {
    const result = classifyProviderError(usageLimit());
    expect(result).toMatchObject({ type: "usage_limit_reached", resetsAt: "2027-01-15T08:00:00.000Z", planType: "plus" });
  });

  it("classifies an exact usage-limit payload serialized into errorMessage", () => {
    expect(classifyProviderError(JSON.stringify(usageLimit().data))).toMatchObject({
      type: "usage_limit_reached",
      resetsAt: "2027-01-15T08:00:00.000Z",
    });
  });

  it("refuses generic 429 rotation", () => {
    expect(classifyProviderError({ status: 429, message: "too many" })).toEqual({ type: "generic", status: 429, message: "too many" });
  });
});

describe("stream retry", () => {
  it("retries exactly once before output and injects alternate apiKey", async () => {
    const creds = new InMemoryCredentialStore();
    await creds.set("a", { accessToken: "token-a" });
    await creds.set("b", { accessToken: "token-b" });
    const calls: unknown[] = [];
    const delegate: CodexDelegate = (_m, _c, options) => {
      calls.push(options);
      if (calls.length === 1) throw usageLimit();
      return delegateEvents([start(), textDelta("ok"), done()])(_m, _c, options);
    };

    const events = await collect(streamSimpleWithPool(model, { messages: [] }, { temperature: 0.2 }, { metadata: metadata(), credentials: creds, delegate }));

    expect(calls).toHaveLength(2);
    expect(calls).toMatchObject([{ apiKey: "token-a" }, { apiKey: "token-b" }]);
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
  });

  it("does not retry after meaningful output", async () => {
    const creds = new InMemoryCredentialStore();
    await creds.set("a", { accessToken: "token-a" });
    await creds.set("b", { accessToken: "token-b" });
    const calls: unknown[] = [];
    const delegate: CodexDelegate = (_m, _c, options) => {
      calls.push(options);
      return delegateEvents([start(), textDelta("partial"), errorEvent(JSON.stringify({ error: { type: "usage_limit_reached", resets_at: 1_800_000_000 } }))])(_m, _c, options);
    };

    const events = await collect(streamSimpleWithPool(model, { messages: [] }, undefined, { metadata: metadata(), credentials: creds, delegate }));

    expect(calls).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "error"]);
  });

  it("surfaces credential refresh failures as terminal stream errors", async () => {
    const creds = new InMemoryCredentialStore();
    const events = await collect(streamSimpleWithPool(model, { messages: [] }, undefined, {
      metadata: metadata(),
      credentials: creds,
      resolveCredential: async () => { throw new Error("refresh-secret-should-not-leak"); },
    }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error: { errorMessage: "Could not refresh credential for A" } });
    expect(JSON.stringify(events)).not.toContain("refresh-secret-should-not-leak");
  });

  it("surfaces pool exhausted and generic errors without hanging", async () => {
    const creds = new InMemoryCredentialStore();
    await creds.set("a", { accessToken: "token-a" });
    const exhausted = metadata();
    exhausted.profiles = exhausted.profiles.map((p) => ({ ...p, exhaustedUntil: "2999-01-01T00:00:00.000Z" }));
    expect((await collect(streamSimpleWithPool(model, { messages: [] }, undefined, { metadata: exhausted, credentials: creds }))).at(-1)?.type).toBe("error");

    const events = await collect(streamSimpleWithPool(model, { messages: [] }, undefined, { metadata: metadata(), credentials: creds, delegate: delegateThrow({ status: 429, message: "nope" }, []) }));
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});

describe("quota parsing", () => {
  it("parses official wham usage shape defensively", () => {
    const parsed = parseUsagePayload({
      plan_type: "plus",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 60, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 45, limit_window_seconds: 604800, reset_after_seconds: 120, reset_at: 1_800_086_400 },
      },
      rate_limit_reset_credits: { available_count: 3 },
    }, new Date("2026-01-01T00:00:00.000Z"));
    expect(parsed).toMatchObject({ plan: "plus", creditsRemaining: 3, primary: { usedPercent: 100, windowSeconds: 18000, resetAt: "2027-01-15T08:00:00.000Z" }, secondary: { usedPercent: 45 } });
  });
});

describe("JWT labels", () => {
  it("extracts nested email and account id without raw JWT", () => {
    const identity = decodeJwtIdentity(jwt({ "https://api.openai.com/profile": { email: "person@example.test" }, "https://api.openai.com/auth": { account_id: "acct_123456789" } }));
    expect(identity).toEqual({ email: "person@example.test", accountId: "acct_123456789", label: "person@example.test" });
  });
});

describe("OAuth enrollment", () => {
  it("adds a verified account and rejects a browser login for the wrong email", () => {
    const oauth = {
      access: jwt({
        "https://api.openai.com/profile": { email: "joelhooks@gmail.com" },
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_gmail" },
      }),
      refresh: "refresh-secret",
      expires: 2_000_000_000_000,
    };
    const enrolled = enrollOAuthCredential(metadata(), oauth, "joelhooks@gmail.com", new Date("2026-07-09T00:00:00.000Z"));

    expect(enrolled.profile).toMatchObject({ label: "joelhooks@gmail.com", email: "joelhooks@gmail.com", accountId: "acct_gmail" });
    expect(enrolled.credential).toMatchObject({ refreshToken: "refresh-secret", expiresAt: 2_000_000_000_000 });
    expect(enrolled.metadata.profiles).toHaveLength(3);
    expect(() => enrollOAuthCredential(metadata(), oauth, "joel@skillrecordings.com")).toThrow(/nothing was saved/);
  });

  it("rolls credential storage back when metadata persistence fails", async () => {
    const store = new InMemoryCredentialStore();
    await store.set("existing", { accessToken: "old-access", refreshToken: "old-refresh" });
    const result = {
      credential: { accessToken: "new-access", refreshToken: "new-refresh" },
      profile: { id: "existing", label: "person@example.test" },
      metadata: { ...metadata(), profiles: [{ id: "existing", label: "person@example.test" }] },
    };

    await expect(saveEnrollment(result, store, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(await store.get("existing")).toEqual({ accessToken: "old-access", refreshToken: "old-refresh" });
  });

  it("refreshes an expiring credential once for concurrent requests", async () => {
    const store = new InMemoryCredentialStore();
    await store.set("a", { accessToken: "old", refreshToken: "refresh-old", expiresAt: 1_000 });
    let calls = 0;
    const refresh = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { access: "new", refresh: "refresh-new", expires: Date.now() + 3_600_000 };
    };

    const [first, second] = await Promise.all([
      freshCredential("a", store, refresh, Date.now()),
      freshCredential("a", store, refresh, Date.now()),
    ]);

    expect(calls).toBe(1);
    expect(first?.accessToken).toBe("new");
    expect(second?.refreshToken).toBe("refresh-new");
  });
});

describe("credential storage", () => {
  it("uses the native keyring binding without process argv", async () => {
    let password = "";
    const store = new MacOSKeychainCredentialStore("test-service", () => ({
      getPassword: () => password,
      setPassword: (value) => { password = value; },
      deletePassword: () => { password = ""; },
    }));

    await store.set("profile-a", { accessToken: "access-secret", refreshToken: "refresh-secret" });

    expect(JSON.parse(password)).toEqual({ accessToken: "access-secret", refreshToken: "refresh-secret" });
    expect(await store.get("profile-a")).toEqual({ accessToken: "access-secret", refreshToken: "refresh-secret" });
  });

  it("falls back to a 0600 credential file when Keychain writes are denied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pool-creds-"));
    const primary = {
      get: async () => undefined,
      set: async () => { throw new Error("User interaction is not allowed"); },
      delete: async () => {},
    };
    const fallback = new FileCredentialStore(dir);
    const store = new FallbackCredentialStore(primary, fallback);
    try {
      await store.set("profile-a", { accessToken: "access-secret", refreshToken: "refresh-secret" });
      expect(await store.get("profile-a")).toEqual({ accessToken: "access-secret", refreshToken: "refresh-secret" });
      expect(await metadataMode(join(dir, "profile-a.json"))).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("secret-free persistence", () => {
  it("writes metadata 0600 and rejects secret-shaped keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pool-meta-"));
    try {
      const path = join(dir, "metadata.json");
      await writeMetadata(path, metadata());
      expect(await metadataMode(path)).toBe(0o600);
      expect(await readFile(path, "utf8")).not.toMatch(/token|bearer/i);
      await expect(writeMetadata(path, { ...metadata(), profiles: [{ id: "x", label: "x", access_token: "secret" } as never] })).rejects.toThrow(/forbidden/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
