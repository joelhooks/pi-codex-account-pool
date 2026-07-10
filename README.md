# @joelhooks/pi-codex-account-pool

Local prototype foundation for a Pi `0.80.6` extension that wraps the existing `openai-codex` provider with account-pool routing.

It preserves Pi's native model catalog, including `openai-codex/gpt-5.6-sol`. Keeping the built-in provider identity is required for Codex tool-call IDs to round-trip correctly across turns.

## Prototype limits

This does **not** implement live login, OAuth callback UI, reset-credit mutation, or real quota refresh wiring. `/codex-pool-refresh` only refreshes local metadata timestamps for this slice.

No tests perform OAuth, network quota calls, or Keychain mutation. They use mocked delegates, fetch, and in-memory credential stores.

## Commands

- `/codex-pool-status` updates Pi status with local profile state.
- `/codex-pool-refresh` rewrites local metadata and updates Pi status. Live `/wham/usage` refresh is a later slice.

## Storage

- Metadata: `~/.pi/codex-account-pool/metadata.json`, secret-free, chmod `0600`.
- Tokens: behind `CredentialStore`; macOS implementation uses `security` via `execFile` with no shell interpolation.

## Retry rule

The wrapper buffers one model attempt. It retries exactly once with another eligible account only when the first attempt fails with structured `usage_limit_reached` before any meaningful text, thinking, or tool event. It does not rotate on generic `429`, auth, transport, or model errors. Once output starts, errors surface directly.

## Source receipts

Grounded against Pi `0.80.6` local install and Pi custom-provider docs. Quota parsing follows OpenAI Codex `rate_limit_resets.rs` / generated `RateLimitStatusPayload` shapes: `plan_type`, `rate_limit.primary_window`, `rate_limit.secondary_window`, `additional_rate_limits`, and `rate_limit_reset_credits.available_count`.
