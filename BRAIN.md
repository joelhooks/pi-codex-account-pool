# pi-codex-account-pool Brain

This package is a standalone local alpha for a Pi extension that adds account-pool routing to Pi's existing `openai-codex` provider.

Durable project notes live in `.brain/projects/pi-codex-account-pool.svx`.

Guardrails:

- OAuth enrollment requires an expected email and rejects mismatched browser sessions before persistence
- the current native Pi login is preserved before adding another account
- no real OAuth or quota calls in tests
- metadata is secret-free and written `0600`
- tokens stay behind `CredentialStore`
