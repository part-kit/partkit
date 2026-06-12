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

`partkit upgrade email.transactional --adapter=postmark` re-vendors and
updates env — never edit `adapters/` by hand. (Until `upgrade` ships:
`partkit eject` then re-`add` with the other adapter.)

## 6. What you must NOT do

- Edit or import anything under `src/internal/**` or `adapters/**`.
- Log `RESEND_API_KEY` / `POSTMARK_SERVER_TOKEN` or full vendor responses.
- Set `RESEND_BASE_URL` / `POSTMARK_BASE_URL` in production — they exist for
  the conformance fakes only.
