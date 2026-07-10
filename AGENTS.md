# Agent Instructions

Work only inside this package. Treat Pi source mirrors as read-only references.

Do not perform live OAuth, quota, reset-credit, release, or account mutations without explicit operator approval.

When changing code:

- keep selection, quota parsing, JWT extraction, and error classification pure/testable
- never log raw OAuth tokens or JWTs
- keep metadata secret-free and chmod `0600`
- use mocked fetch/delegate/keychain in tests
- run `npm test`, `npm run typecheck`, `npm run build`, and `npm run brain:check`
