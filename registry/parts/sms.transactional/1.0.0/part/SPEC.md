# SPEC — sms.transactional 1.0.0

Send one transactional SMS over a vendor-neutral contract, with **twilio** and
**amazon-sns** attested for v1. E.164 recipient, a plain-text body, transient
retry, typed errors, secret redaction. Stateless: no database, no migrations.

This is the SMS twin of `email.transactional` and its second worked vendor-flip:
the cheap vendor (SNS) is the fiddly one to integrate, so an agent reaches for the
easy/pricey one (Twilio) — and PartKit makes the swap one command.

## Design decisions

- **Both adapters are zero-dependency.** Twilio is one HTTP Basic-auth POST to the
  Messages REST endpoint (form body, JSON response → `sid`). Amazon SNS is an SNS
  `Publish` over the query protocol (form body, XML response → `MessageId`),
  **SigV4-signed by hand** — reusing the SAME `src/internal/sigv4.ts` the SES
  email adapter proved (just `service=sns`). No `aws-sdk`, no `twilio` SDK; the
  whole supply chain is the part's own files + node's `fetch`/`crypto`.
- **The SigV4 chain is anchored to AWS's own documented vector.** Conformance
  derives AWS's published signing key byte-for-byte (`signingKey` KAT), so a wrong
  signature can't pass — the fake vendor records the request but does not verify
  the signature. `sigv4.ts` ships in the part for the amazon-sns adapter, so the
  KAT runs in every materialization.
- **Sender semantics differ, hidden behind one interface.** Twilio needs a sender:
  `message.from` or `TWILIO_FROM`, routed to `From` (a number) or
  `MessagingServiceSid` (an `MG…` SID); absent both → `SmsError("config")`. SNS
  uses the account's provisioned origination and ignores `from` (documented).
- **Validate before the wire.** The recipient must be E.164
  (`/^\+[1-9]\d{1,14}$/`); the body must be non-empty and within a sane cap (1600
  chars ≈ 10 segments); control characters are rejected (C0/C1 + DEL, allowing
  `\t`/`\n`/`\r` in a body but never in a sender). The check is over character
  codes so the source carries no literal control bytes. Invalid input → zero
  network calls.
- **Retry only the transient.** 429/5xx/network are `retryable`; up to 3 attempts
  with exponential backoff + full jitter. Auth and 4xx-reject are permanent.
- **No raw vendor internals escape.** Errors are built from the HTTP status alone;
  response bodies are never read into a message. Secret env values are stripped
  from any message via `redactSecrets`.
- **`SMS_ADAPTER` must match the vendored adapter** — a deploy-mismatch (someone
  set `SMS_ADAPTER=twilio` but vendored amazon-sns) fails fast with a `config`
  error naming the `partkit upgrade` fix, rather than silently mis-sending.

## Invariant → conformance mapping

The SAME suite runs once per adapter (the publish script materializes each into
`adapters/selected/` and branches on `adapter.name` via a per-vendor profile).
Both adapters are zero-dependency, so the suite needs no extra packages; it drives
a protocol-faithful fake HTTP server (`fake-vendor.ts`).

| # | Invariant | Test(s) |
|---|---|---|
| 1 | No-I/O import; config validated at call time, typed | "config is validated at call time…", "SMS_ADAPTER must match the vendored adapter" |
| 2 | Invalid message fails fast, zero network | "an invalid recipient fails fast with zero network calls" |
| 3 | Control chars in body/sender rejected | "disallowed control characters in the body are rejected" |
| 4 | Transient retried (≤3, backoff); permanent never | "a transient 429 is retried", "persistent 5xx exhausts exactly 3 attempts", "auth failures are NEVER retried" |
| 5 | Typed errors; raw vendor bodies never escape | "failures are typed SmsError values; raw vendor bodies never escape" |
| 6 | Secrets never in error messages | "secret values never appear in error messages" |
| + | SigV4 chain byte-correct (amazon-sns) | "derives AWS's documented signing key byte-for-byte" |

11 tests per adapter (twilio, amazon-sns), all offline.

## <a id="threat-model"></a>Threat model

| Threat | Mitigation |
|---|---|
| **Header / payload injection via the body or sender** | Control characters (C0/C1 + DEL) are rejected pre-send; values are carried as form-encoded params (Twilio/SNS) — never spliced into a URL, header, or signed string by hand. |
| **A crafted recipient probes other endpoints** | `to` must match the E.164 pattern; the request URL/host is fixed per adapter (or a test-only base-URL override). |
| **Secret leakage in errors/logs** | Errors are built from HTTP status only (bodies unread); `redactSecrets` strips `TWILIO_AUTH_TOKEN` / `AWS_SECRET_ACCESS_KEY` from any escaping message. |
| **A forged SigV4 signature passes silently** | The signing-key chain is anchored to AWS's documented known-answer vector in conformance; drift fails the build. |
| **Retry storms on a permanent failure** | Only 429/5xx/network are retried (≤3, jittered); auth/4xx-reject are terminal. |

Out of scope (v1): inbound SMS / delivery receipts (a webhooks.ingest composition,
like email's delivery events); MMS; per-message SNS Sender ID / OriginationNumber
overrides; idempotency keys (neither vendor exposes a clean one for a single
send). Carrier registration (10DLC, Sender IDs) and the SNS sandbox exit are
operator responsibilities, not code.

## Roadmap

- Delivery receipts / inbound via `webhooks.ingest` (additive minor).
- More adapters (Vonage, MessageBird, Plivo) — interchangeable by construction.
- Per-message SNS origination / Sender ID attributes.
