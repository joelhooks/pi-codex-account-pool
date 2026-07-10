# pi-codex-account-pool Brain

This package is a standalone local prototype for a Pi extension that adds account-pool routing to Pi's existing `openai-codex` provider.

Durable project notes live in `.brain/projects/pi-codex-account-pool.svx`.

Guardrails:

- no live OAuth setup in this prototype
- no real quota calls in tests
- metadata is secret-free and written `0600`
- tokens stay behind `CredentialStore`
