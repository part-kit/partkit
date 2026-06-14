# Seams — sms.transactional

What YOUR app provides. Reading `contract.json` + this file is enough to wire the
part — you never need to read `src/`. Never edit `src/` or `adapters/selected/`
(attested interior; edits void the attestation and fail CI).

This part sends one transactional SMS through a vendor-neutral interface — an
E.164 recipient, a plain-text body — with transient-retry, typed errors, and
secrets kept out of logs. Two attested vendors: **Twilio** (one Basic-auth REST
call) and **Amazon SNS** (SigV4-signed Publish). Stateless: no database, no
migrations.

## 1. Environment

| Var | Required | Secret | What |
|---|---|---|---|
| `SMS_ADAPTER` | yes | no | `twilio` or `amazon-sns` — must match the vendored adapter. |
| `TWILIO_ACCOUNT_SID` | twilio | no | Your Twilio Account SID (`AC…`). |
| `TWILIO_AUTH_TOKEN` | twilio | yes | Your Twilio Auth Token. |
| `TWILIO_FROM` | no | no | Default sender — a Twilio number (E.164) or a Messaging Service SID (`MG…`). A per-message `from` overrides it. |
| `AWS_ACCESS_KEY_ID` | amazon-sns | yes | IAM access key with `sns:Publish`. |
| `AWS_SECRET_ACCESS_KEY` | amazon-sns | yes | IAM secret key. |
| `AWS_REGION` | amazon-sns | no | The SNS region, e.g. `us-east-1`. |

Only the selected adapter's vars are needed. Secrets are redacted from every
error message. Importing the part reads no env and performs no I/O; config is
validated on first `send` with a typed `SmsError("config")`.

### 1b. Choosing the vendor — and the one-command flip

The interface is identical for both vendors; only `SMS_ADAPTER` + the credentials
change. Flip with `partkit upgrade sms.transactional --adapter=amazon-sns` (or
`--adapter=twilio`) — no app code changes. Twilio is the quick start; SNS is
typically cheaper per segment at volume but needs AWS provisioning.

**Twilio one-time provisioning** (the human's ~10 min): create an account, buy a
sending number **or** create a Messaging Service (SID `MG…`), and set it as
`TWILIO_FROM` (or pass `from` per message).

**Amazon SNS one-time provisioning** (the human's ~15 min): an IAM user/role with
`sns:Publish`; **exit the SMS sandbox** (until then SNS only sends to verified
numbers); set your origination identity (a number or, where allowed, a Sender
ID) and a monthly spending limit in the SNS console. The amazon-sns adapter uses
the **account's provisioned origination** and ignores per-message `from`.

## 2. Sending

```ts
import { send } from "@parts/sms.transactional"; // or ../parts/sms.transactional/src/index

const { id } = await send({
  to: "+15551234567",   // E.164 — validated before any network call
  body: "Your code is 123456",
  from: "+15559876543", // optional; Twilio uses it (or TWILIO_FROM), SNS ignores it
});
// id = the vendor message id (Twilio SID / SNS MessageId), for your logs
```

`send` validates first: a non-E.164 `to`, an empty `body`, or disallowed control
characters fail fast with `SmsError("invalid_message")` and **zero** network
calls. Transient vendor failures (429, 5xx, network) are retried up to 3 times
with backoff + jitter; permanent failures (auth, rejected) are never retried.

## 3. Error handling

Every failure is an `SmsError` with `.code`, `.retryable`, `.status`:

| code | meaning | retryable |
|---|---|---|
| `config` | a required env var is missing, or `SMS_ADAPTER` ≠ the vendored adapter | no |
| `invalid_message` | bad `to`/`body`/`from` (caught before any send) | no |
| `auth` | vendor rejected the credentials (401/403) | no |
| `rate_limited` | vendor 429 | yes |
| `rejected` | vendor 4xx (bad number, opted-out, etc.) | no |
| `vendor_unavailable` | vendor 5xx or a network failure | yes |

Raw vendor response bodies are never read into error messages, and secret env
values are stripped from any message that escapes.

## 4. Honesty — pricing & deliverability are the founder's

SMS pricing is **per-segment** and carrier-dependent; a long message is billed as
several segments. Quote per-segment vendor rates with a date stamp — never a flat
monthly figure. The vendor flip is one commit *in code*; **carrier registration
(US 10DLC, alphanumeric Sender IDs, the SNS sandbox exit) and number provisioning
remain the founder's** and gate actual deliverability.

## 5. What you must NOT do

- Edit anything under `src/` or `adapters/selected/`.
- Set `TWILIO_BASE_URL` / `SNS_BASE_URL` in production — those overrides exist only
  for the conformance fakes.
- Put secrets anywhere but the adapter's env vars (they are redacted from errors,
  but only the declared ones).
