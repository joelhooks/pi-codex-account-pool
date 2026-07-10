import { createAssistantMessageEventStream, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { streamSimple as builtinStreamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { classifyProviderError } from "./errors.js";
import { selectAlternateProfile, selectProfile } from "./selection.js";
import type { CredentialStore, PoolMetadata, PoolProfile } from "./types.js";

export type CodexDelegate = StreamFunction<"openai-codex-responses", SimpleStreamOptions>;
export type MetadataWriter = (metadata: PoolMetadata) => Promise<void> | void;

export interface PooledStreamOptions {
  metadata: PoolMetadata | (() => Promise<PoolMetadata> | PoolMetadata);
  credentials: CredentialStore;
  writeMetadata?: MetadataWriter;
  delegate?: CodexDelegate;
  now?: () => Date;
}

export function streamSimpleWithPool(
  model: Model<"openai-codex-responses">,
  context: Context,
  options: SimpleStreamOptions | undefined,
  pool: PooledStreamOptions,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void runPooledStream(model, context, options, pool, output);
  return output;
}

async function runPooledStream(
  model: Model<"openai-codex-responses">,
  context: Context,
  options: SimpleStreamOptions | undefined,
  pool: PooledStreamOptions,
  output: AssistantMessageEventStream,
): Promise<void> {
  const now = pool.now ?? (() => new Date());
  const delegate = pool.delegate ?? builtinStreamSimple;
  let metadata = typeof pool.metadata === "function" ? await pool.metadata() : pool.metadata;
  const first = selectProfile(metadata, now());
  if (!first) {
    pushError(output, model, "Codex account pool exhausted");
    return;
  }
  const firstResult = await attempt(first, delegate, model, context, options, pool.credentials, output, true);
  if (firstResult === "done" || firstResult === "streaming-error") return;
  const alternate = selectAlternateProfile(metadata, first.id, now());
  if (alternate) {
    metadata = {
      ...metadata,
      activeProfileId: alternate.id,
      updatedAt: now().toISOString(),
      profiles: metadata.profiles.map((p) => p.id === first.id ? { ...p, exhaustedUntil: firstResult.resetsAt } : p),
    };
    await pool.writeMetadata?.(metadata);
    await attempt(alternate, delegate, model, context, options, pool.credentials, output, false);
    return;
  }
  metadata = {
    ...metadata,
    activeProfileId: undefined,
    updatedAt: now().toISOString(),
    profiles: metadata.profiles.map((p) => p.id === first.id ? { ...p, exhaustedUntil: firstResult.resetsAt } : p),
  };
  await pool.writeMetadata?.(metadata);
  pushError(output, model, `Codex account pool exhausted until ${firstResult.resetsAt}`);
}

type AttemptResult = "done" | "streaming-error" | { type: "usage_limit_reached"; resetsAt: string };

async function attempt(
  profile: PoolProfile,
  delegate: CodexDelegate,
  model: Model<"openai-codex-responses">,
  context: Context,
  options: SimpleStreamOptions | undefined,
  credentials: CredentialStore,
  output: AssistantMessageEventStream,
  allowRetrySignal: boolean,
): Promise<AttemptResult> {
  const credential = await credentials.get(profile.id);
  if (!credential?.accessToken) {
    pushError(output, model, `Missing credential for ${profile.label}`);
    return "streaming-error";
  }
  const buffered: AssistantMessageEvent[] = [];
  let meaningful = false;
  let flushed = false;
  const flush = () => { if (!flushed) { for (const event of buffered) output.push(event); flushed = true; } };

  try {
    const stream = delegate(model, context, { ...options, apiKey: credential.accessToken });
    for await (const event of stream) {
      if (isMeaningful(event)) meaningful = true;
      if (meaningful) {
        flush();
        output.push(event);
      } else {
        buffered.push(event);
      }
      if (event.type === "error") {
        const classification = classifyProviderError(event.error.errorMessage ?? event.error);
        if (allowRetrySignal && !meaningful && classification.type === "usage_limit_reached") return classification;
        flush();
        output.end();
        return "streaming-error";
      }
      if (event.type === "done") {
        flush();
        output.end(event.message);
        return "done";
      }
    }
    flush();
    output.end();
    return "done";
  } catch (error) {
    const classification = classifyProviderError(error);
    if (allowRetrySignal && !meaningful && classification.type === "usage_limit_reached") return classification;
    flush();
    pushError(output, model, classification.type === "generic" ? classification.message ?? "Codex pool request failed" : "Codex pool request failed");
    return "streaming-error";
  }
}

export function isMeaningful(event: AssistantMessageEvent): boolean {
  return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta" || event.type === "toolcall_end" || event.type === "text_end" || event.type === "thinking_end";
}

function pushError(output: AssistantMessageEventStream, model: Model<"openai-codex-responses">, message: string): void {
  output.push({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  });
  output.end();
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
