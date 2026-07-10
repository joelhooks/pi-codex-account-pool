# @joelhooks/pi-codex-account-pool

Local alpha for a Pi `0.80.6` extension that wraps the existing `openai-codex` provider with account-pool routing.

It preserves Pi's native model catalog, including `openai-codex/gpt-5.6-sol`. Keeping the built-in provider identity is required for Codex tool-call IDs to round-trip correctly across turns.

## Alpha limits

Account enrollment and automatic access-token refresh are wired. Real quota refresh, account removal/pinning UI, reset-credit mutation, and fleet-wide refresh serialization are not yet wired. `/codex-pool-refresh` still refreshes only local metadata timestamps.

No tests perform live OAuth, network quota calls, or Keychain mutation. They use mocked credentials, delegates, fetch, and native-keyring adapters.

## Commands

- `/codex-pool-add second@example.com` preserves Pi's current Codex login, opens OpenAI OAuth, verifies the returned email, and adds the new account to the credential store.
- `/codex-pool-import-current [expected@email.com]` explicitly imports Pi's current `openai-codex` OAuth credential.
- `/codex-pool-status` shows local profiles and reset state.
- `/codex-pool-refresh` rewrites local metadata and updates Pi status. Live `/wham/usage` refresh is the next slice.

If the browser is already signed into the wrong ChatGPT account, switch accounts there. A mismatched email is rejected before tokens or metadata are saved.

## Storage

- Metadata: `~/.pi/codex-account-pool/metadata.json`, secret-free, chmod `0600`.
- Tokens: behind `CredentialStore`. The primary macOS backend uses native Security.framework bindings, so secrets never enter shell source, argv, or environment variables.
- Background launchd sessions can be denied Keychain interaction by macOS. In that case the extension falls back to per-profile `0600` files under `~/.pi/codex-account-pool/credentials/`, matching Pi's own `auth.json` threat model.

## Retry rule

The wrapper buffers one model attempt. It retries exactly once with another eligible account only when the first attempt fails with structured `usage_limit_reached` before any meaningful text, thinking, or tool event. It does not rotate on generic `429`, auth, transport, or model errors. Once output starts, errors surface directly.

## Source receipts

Grounded against Pi `0.80.6` local install and Pi custom-provider docs. Quota parsing follows OpenAI Codex `rate_limit_resets.rs` / generated `RateLimitStatusPayload` shapes: `plan_type`, `rate_limit.primary_window`, `rate_limit.secondary_window`, `additional_rate_limits`, and `rate_limit_reset_credits.available_count`.
