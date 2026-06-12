# Seams — webhooks.ingest

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` or `adapters/`
(attested interiors; edits void the attestation and fail CI).

## 1. Environment

| Var | Required | Notes |
|---|---|---|
| `WEBHOOK_ADAPTER` | yes | Must equal the vendored adapter — `partkit add` already set it in `.env.example`. |
| `WEBHOOK_SECRET` | yes | Secret. The signing secret from your vendor's webhook settings (`whsec_…` for both schemes). |
| `WEBHOOK_TOLERANCE_SECONDS` | no | Signed-timestamp window, default `300`. Widen only for vendors with documented delivery lag. |

Which adapter for which vendor: `stripe` for Stripe; `standardwebhooks` for
any Svix-delivered or Standard-Webhooks-compliant sender (Resend, Clerk, …).

## 2. Import path

Add one tsconfig alias (recommended):

```jsonc
// tsconfig.json → compilerOptions
"paths": { "@parts/*": ["./parts/*/src"] }
```

Then:

```ts
import { onWebhook, webhookHandler, verifyWebhook, WebhookError } from "@parts/webhooks.ingest";
```

Plain relative imports of `parts/webhooks.ingest/src/index.js` work too.
Never deep-import `src/internal/**` or `adapters/**` (lint-enforced).

## 3. The mount (the route seam)

The contract declares one route: `POST /api/webhooks/ingest`. In Next App
Router YOU own the route file — create `app/api/webhooks/ingest/route.ts`,
register your handlers, and re-export the part's handler. Start from
`examples/next-route.ts`, which is outside the boundary and freely copyable:

```ts
import { onWebhook, webhookHandler } from "@parts/webhooks.ingest";

onWebhook(async (event) => {
  const body = JSON.parse(event.payload);
  // dispatch on YOUR vendor's event types
});

export const POST = webhookHandler;
```

Rules that make this safe:

- **Register at module scope, in the same file that mounts the handler.**
  Registration is re-evaluated per cold start (serverless-sanctioned). A
  mounted route with zero registered handlers answers `500` on purpose — the
  vendor keeps redelivering until your deploy is fixed, so no events are lost.
- **The handler runs before the vendor gets its 2xx.** Keep handlers short
  (record + enqueue); a throwing handler answers `500` and the vendor
  redelivers. Make handlers idempotent — at-least-once delivery is the
  vendor's contract, and a redelivery after a crash WILL re-run them.
- **Raw body is handled for you.** `webhookHandler` reads the exact raw bytes
  from the `Request`. Do not wrap it in middleware that parses or re-encodes
  the body.

## 4. Verifying without the mount (`verifyWebhook`)

Using your own route or a non-Next runtime? Call `verifyWebhook` directly —
the ONE rule is: pass the raw body string, never a parsed-then-re-serialized
object (verification is over exact bytes and will rightly fail otherwise):

```ts
export async function POST(req: Request) {
  const payload = await req.text();           // RAW body — before any .json()
  try {
    const event = await verifyWebhook({ payload, headers: req.headers });
    // event.id, event.timestamp (the SIGNED time), event.payload
  } catch (e) {
    if (e instanceof WebhookError) return new Response(null, { status: e.status });
    throw e;
  }
  return Response.json({ received: true });
}
```

## 5. Error handling

Every failure is a `WebhookError` with `.code` (`"config" | "missing_header" |
"invalid_signature" | "timestamp_out_of_window" | "replayed" | "unknown"`) and
`.status` — the HTTP status to answer the vendor with (400 = don't redeliver
this request, 500 = our side is broken, do redeliver). Trust `event.timestamp`
(it is signed); never trust timestamps inside the payload.

## 6. Replay defense — what v1 does and does not give you

Signed-timestamp window plus an in-memory replay cache **per instance**. On
serverless, concurrent instances do not share the cache, so a replay can be
accepted once per instance within the window (SPEC.md#threat-model). If your
handler is idempotent (§3) this is harmless. Durable cross-instance replay
defense arrives as an additive minor with the DB story.

## 7. Switching schemes

`partkit upgrade webhooks.ingest --adapter=standardwebhooks` re-vendors and
updates env — never edit `adapters/` by hand. (Until `upgrade` ships:
`partkit eject` then re-`add` with the other adapter.)

## 8. What you must NOT do

- Edit or import anything under `src/internal/**` or `adapters/**`.
- Parse-then-re-serialize the body before verification (§4 — bytes matter).
- Log `WEBHOOK_SECRET` or echo verification error details back to the caller.
- Treat a `replayed` or `timestamp_out_of_window` rejection as a bug — it is
  the defense working; the vendor's genuine retries are re-signed and pass.
