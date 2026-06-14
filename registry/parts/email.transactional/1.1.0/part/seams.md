# Seams — email.transactional

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` or `adapters/`
(attested interiors; edits void the attestation and fail CI).

## 1. Environment

| Var | Required | Notes |
|---|---|---|
| `EMAIL_ADAPTER` | yes | Must equal the vendored adapter — `partkit add` already set it in `.env.example`. |
| `EMAIL_FROM` | yes | `"Acme <hello@yourdomain.com>"` or bare address. The domain must be verified with your vendor. |
| `RESEND_API_KEY` | when adapter = resend | Secret. |
| `POSTMARK_SERVER_TOKEN` | when adapter = postmark | Secret. `POSTMARK_MESSAGE_STREAM` optional (default `outbound`). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | when adapter = ses | Secret IAM keys with the `ses:SendEmail` action. |
| `AWS_REGION` | when adapter = ses | e.g. `us-east-1` — the SES region your identity is verified in. |

## 1b. SES — the one-time AWS setup (when adapter = ses)

The adapter writes **zero** SES code for you — no `aws-sdk`, no SigV4 signing —
but AWS still requires a few account-side steps once. Do these in the AWS
console for the region in `AWS_REGION`:

1. **Verify a sending identity** — a domain (recommended) or a single From
   address. SES → Identities → Create identity.
2. **Enable DKIM** — "Easy DKIM"; add the CNAME records it shows (automatic on
   Route 53). Verifying the domain + DKIM before step 3 speeds approval.
3. **Request production access** — SES → Account dashboard → "Request production
   access" (a new account is in the *sandbox*: it can only send to verified
   addresses, ~200/day, 1/sec). Approval is usually within ~24h.
4. **IAM** — create an access key for a user/role with the `ses:SendEmail`
   action; put it in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. (These are
   normal IAM keys, *not* SMTP credentials.)
5. **`EMAIL_FROM`** must be an address on the verified identity.

That's the whole job — after this, sending is the same `send()` call as any
other adapter. Switching here from resend/postmark is one commit (§5).

## 2. Import path

Add one tsconfig alias (recommended):

```jsonc
// tsconfig.json → compilerOptions
"paths": { "@parts/*": ["./parts/*/src"] }
```

Then:

```ts
import { send, EmailError } from "@parts/email.transactional";
```

Plain relative imports of `parts/email.transactional/src/index.js` work too.
Never deep-import `src/internal/**` or `adapters/**` (lint-enforced).

## 3. Templates are YOUR domain (the template seam)

The part sends; it does not own your copy. Write plain functions that return
`{ subject, html, text }` and keep them in app code (e.g. `src/email/`) —
start from `examples/welcome-email.ts`, which is outside the boundary and
freely copyable.

## 4. Error handling

Every failure is an `EmailError` with `.code` (`"config" | "invalid_message" |
"auth" | "rate_limited" | "rejected" | "vendor_unavailable" | "unknown"`) and
`.retryable`. Retries already happened inside the part — if you catch a
retryable error, queue or defer; do not instant-retry in a loop.

## 5. Switching vendors

`partkit upgrade email.transactional --adapter=ses` (or `=postmark`, `=resend`)
re-vendors and updates env — never edit `adapters/` by hand. The `send()` calls
never change, so a vendor swap (e.g. resend → SES when your Resend bill climbs)
is one commit. (Until `upgrade` ships: `partkit eject` then re-`add`.)

## 6. What you must NOT do

- Edit or import anything under `src/internal/**` or `adapters/**`.
- Log `RESEND_API_KEY` / `POSTMARK_SERVER_TOKEN` / `AWS_SECRET_ACCESS_KEY` or full vendor responses.
- Set `RESEND_BASE_URL` / `POSTMARK_BASE_URL` / `SES_BASE_URL` in production — they exist for
  the conformance fakes only.
