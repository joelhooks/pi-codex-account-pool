import { setup } from "xstate";
import type { PoolMetadata, PoolProfile } from "./types.js";

export type PoolStatus = "starting" | "refreshingUsage" | "selecting" | "available" | "requesting" | "streaming" | "exhausted" | "poolExhausted" | "failed";

export interface PoolMachineContext {
  metadata: PoolMetadata;
  active?: PoolProfile;
  error?: string;
}

export const codexPoolMachine = setup({
  types: {} as {
    context: PoolMachineContext;
    events:
      | { type: "REFRESH" }
      | { type: "REFRESHED" }
      | { type: "SELECT" }
      | { type: "SELECTED"; profile: PoolProfile }
      | { type: "REQUEST" }
      | { type: "MEANINGFUL_OUTPUT" }
      | { type: "USAGE_LIMIT" }
      | { type: "POOL_EMPTY" }
      | { type: "FAIL"; error: string }
      | { type: "RESET" };
  },
}).createMachine({
  id: "codexAccountPool",
  initial: "starting",
  context: ({ input }) => input as PoolMachineContext,
  states: {
    starting: { on: { REFRESH: "refreshingUsage", SELECT: "selecting" } },
    refreshingUsage: { on: { REFRESHED: "selecting", FAIL: "failed" } },
    selecting: { on: { SELECTED: "available", POOL_EMPTY: "poolExhausted", FAIL: "failed" } },
    available: { on: { REQUEST: "requesting", REFRESH: "refreshingUsage" } },
    requesting: { on: { MEANINGFUL_OUTPUT: "streaming", USAGE_LIMIT: "exhausted", FAIL: "failed" } },
    streaming: { on: { FAIL: "failed", RESET: "available" } },
    exhausted: { on: { SELECT: "selecting", POOL_EMPTY: "poolExhausted" } },
    poolExhausted: { on: { REFRESH: "refreshingUsage" } },
    failed: { on: { RESET: "selecting" } },
  },
});
