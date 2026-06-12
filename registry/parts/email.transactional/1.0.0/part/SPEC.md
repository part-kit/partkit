# email.transactional — SPEC

Send transactional email through a contract-stable interface with pluggable,
attested vendor adapters. v1 scope is **sending**; delivery events arrive as
an additive minor once `webhooks.ingest` exists to compose on.

## Design decisions

- **Zero npm dependencies.** Adapters speak the vendor REST APIs directly over
  node's `fetch`. The part's entire supply chain is its own files — nothing
  to audit beyond what is vendored and hashed.
- **Lazy configuration.** Importing the part performs no I/O and never
  throws; env is read and validated at call time with typed errors. This is
  the serverless-safety rule from docs/02 §2 applied.
- **Static adapter import.** Part code imports `../adapters/selected/adapter.js`;
  `partkit add` flattens the chosen adapter there at vendor time. No dynamic
  imports for bundlers to mishandle.
- **Retry policy.** Up to 3 attempts, exponential backoff with full jitter,
  retrying only 429/5xx/network. Permanent failures (auth, validation) never
  retry.
- **Vendor fakes for conformance.** Protocol-faithful HTTP fakes validate auth
  headers, payload shape, and retry traffic. `*_BASE_URL` env overrides exist
  solely so the conformance suite can point adapters at the fakes — never set
  them in production.

## Invariant → conformance test mapping

| # | Invariant (contract.json) | Test (conformance/send.test.ts) |
|---|---|---|
| 1 | Import performs no I/O; config validated at call time | "invariant 1: config is validated at call time…" |
| 2 | Invalid message → typed error, zero network | "invariant 2: an invalid message fails fast…" |
| 3 | CR/LF rejected (header injection) | "invariant 3: CR/LF in subject…" |
| 4 | Retries: 3 attempts, transient-only | "invariant 4a/4b/4c…" |
| 5 | Only typed EmailError escapes; bodies unread | "invariant 5: failures are typed…" |
| 6 | Secrets never in error messages | "invariant 6: secret values never appear…" |

## Threat model

- **API key exposure.** Keys are read lazily from env, never logged, and
  scrubbed from every error message (redaction list in
  `src/internal/config.ts`). Vendor response bodies are never read into
  errors, so reflected-key responses cannot leak through us.
- **Header injection.** CR/LF in subject, display names, or custom headers is
  rejected before any network call. Recipient addresses are format-validated.
- **SSRF.** Endpoints are fixed vendor URLs. The `*_BASE_URL` overrides are
  test-only; a compromised env already implies a stronger attacker than this
  part defends against, but the seams doc forbids setting them in production.
- **Cost amplification.** Retries are capped at 3 attempts with backoff; only
  transient failures retry, so a rejected message cannot burn quota in a loop.
- **PII.** The part stores nothing; messages pass through to the vendor. No
  tables, no logs.

## Roadmap

- `1.1` (minor, additive): delivery events via `webhooks.ingest` composition —
  `events: ["email.delivered", "email.bounced", "email.complained"]`.
- SES adapter: requires SigV4 signing plus real-sandbox conformance (no
  protocol-faithful fake is honest for SigV4); enters as `community` until the
  verification CI runs it against real AWS.
