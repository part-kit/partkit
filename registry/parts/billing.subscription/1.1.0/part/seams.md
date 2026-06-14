# Seams — billing.subscription

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` or
`adapters/selected/` (attested interior; edits void the attestation and fail CI).

This part gives you Stripe- or Paddle-backed subscriptions through a vendor-
neutral interface: a hosted checkout, a **webhook-derived** subscription mirror in your
own Postgres, cancel / reactivate / change-plan, and a derived `entitled` flag.
**Subscription state is never trusted from the client** — it is written only
after a signed webhook is verified.

## 1. Environment

| Var | Required | Secret | What |
|---|---|---|---|
| `BILLING_SECRET_KEY` | yes | yes | The vendor API key for write calls (checkout/cancel/change). **Stripe:** `sk_test_…`/`sk_live_…` (Developers → API keys). **Paddle:** `pdl_sdbx_apikey_…`/`pdl_live_apikey_…` (Developer tools → Authentication); the prefix auto-selects the sandbox vs live base URL. |
| `BILLING_WEBHOOK_SECRET` | yes | yes | The signing secret used to verify inbound events. **Stripe:** webhook endpoint secret `whsec_…` (Developers → Webhooks → your endpoint). **Paddle:** notification destination secret `pdl_ntfset_…` (Developer tools → Notifications → your destination). |
| `BILLING_ADAPTER` | no | no | Records which adapter was vendored (`stripe`/`paddle`); written by `partkit add/upgrade`. Selection is **build-time** (the chosen adapter is flattened into `adapters/selected/`), so this is informational — flip with `partkit upgrade billing.subscription --adapter=…`, not by editing this at runtime. |

Secrets are redacted from every error message. Importing the part reads no env
and performs no I/O; config is validated on first use with a typed
`BillingError("config")`.

### 1b. Choosing the vendor — and the one-command flip

The interface is identical for both vendors; only `BILLING_ADAPTER` + the two
secrets change. To switch (e.g. Stripe → Paddle for merchant-of-record tax
handling): `partkit upgrade billing.subscription --adapter=paddle`, set the
Paddle secrets, point your webhook at the same route — **no app code changes**.

**Paddle one-time provisioning** (the human's ~15 min, isolated from code):
- Create an API key with `transaction.write`, `customer.write`, `subscription.write`.
- Set a **Default Payment Link** (Paddle → Checkout → Checkout settings) — the
  hosted-checkout URL is built from it; without it, checkout creation fails. The
  post-payment **success/cancel redirect is configured here**, not per call
  (Stripe takes `successUrl`/`cancelUrl` per checkout; for Paddle those args are
  accepted for interface parity but the dashboard setting governs the redirect).
- Create a **Notification destination** and copy its `pdl_ntfset_…` secret into
  `BILLING_WEBHOOK_SECRET`; subscribe to the events in §5.
- On Paddle, `createCheckout` **requires `userEmail`** (a transaction binds to a
  customer, created or looked-up by email). Stripe makes it optional.

## 2. Database — the `SqlExecutor` seam

The part owns the `billing_subscriptions` and `billing_events` tables but
imports no driver. Bring a Postgres client shaped as:

```ts
interface SqlExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
```

Wire a `pg.Pool` to it — see `examples/pg-executor.ts`. Create the tables with
`partkit migrate` (ships `migrations/001-create-billing-tables.sql`). Then:

```ts
import { billing } from "@parts/billing.subscription"; // or ../parts/billing.subscription/src/index
const b = billing(db); // construct per request; no I/O until a method runs
```

## 3. The plan catalog seam

Your app maps its plan ids to vendor price ids — the part never hardcodes
prices. Supply a `PlanCatalog` (see `examples/plan-catalog.ts`):

```ts
interface Plan { id: string; stripePriceId: string; label?: string }
interface PlanCatalog { get(planId: string): Plan | null; list(): Plan[] }
```

> The field is named `stripePriceId` for interface stability across the 1.x line;
> it holds **the selected vendor's price id** — a Stripe `price_…` or a Paddle
> `pri_…`. (A future major may rename it `priceId`.)

`createCheckout` and `changePlan` take the catalog per call; an unknown plan id
fails fast with `BillingError("invalid_input")` and zero side effects.

## 4. Checkout (the common case)

```ts
const session = await billing(db).createCheckout({
  userId,                 // YOUR opaque user id — stored as-is, no FK to auth tables
  planId: "pro",
  catalog,
  successUrl: "https://app.example.com/billing/success?session_id={CHECKOUT_SESSION_ID}",
  cancelUrl:  "https://app.example.com/billing",
  userEmail,              // Stripe: optional (prefills the Customer). Paddle: REQUIRED.
});
redirect(session.url);    // vendor-hosted checkout page
```

`createCheckout` writes **no** subscription row. The success page must NOT grant
access — it only confirms "we're finishing up". Access is granted when the
webhook lands (§5) and your `onSubscriptionChange` handler (or a re-read of
`getSubscription`) sees `entitled === true`.

## 5. The webhook seam (REQUIRED — this is the source of truth)

Mount the handler at `POST /api/webhooks/billing` and register that URL in your
vendor's dashboard (Stripe → Webhooks / Paddle → Notifications). **If you use
`onSubscriptionChange` (§7), build one `billing(db)`
instance and mount its `b.webhookHandler()`** — handlers are in-process, so the
route must share the instance they were registered on:

```ts
const b = billing(db);
b.onSubscriptionChange(/* … */);
export const POST = b.webhookHandler();
```

`billingWebhookHandler(db)` is the standalone shortcut for apps that react by
re-reading `getSubscription` instead of via handlers (it registers none).
**The route must pass the RAW request body** —
the signature is verified over the exact bytes. In Next.js App Router a route
handler receives the raw `Request` (do not add a body parser); in Express use
`express.raw({ type: "application/json" })` *before* `express.json()`. See
`examples/webhook-route.ts`.

Configure the endpoint to send exactly these events:
- **Stripe:** `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
  `invoice.payment_failed`.
- **Paddle:** `subscription.created`, `subscription.updated`,
  `subscription.activated`, `subscription.canceled`, `transaction.payment_failed`.

The handler reads the correct signature header per vendor automatically
(`Stripe-Signature` / `Paddle-Signature`).

The handler returns **200** when verified and (idempotently) applied, **400** on
a bad/expired signature (the vendor must not redeliver), and **500** on a transient
error (the vendor will redeliver — safe, because the same event id is applied at
most once).

## 6. Reading entitlement + lifecycle actions

```ts
const sub = await billing(db).getSubscription(userId); // Subscription | null
if (sub?.entitled) { /* allow the paid feature */ }    // entitled = status ∈ {active, trialing}

await billing(db).cancelAtPeriodEnd({ subscriptionId }); // ends at period end
await billing(db).reactivate({ subscriptionId });        // undo the above
await billing(db).changePlan({ subscriptionId, newPlanId: "team", catalog });
```

These return an **optimistic** Subscription (the API result) but do not write the
mirror — the authoritative update arrives via the `customer.subscription.updated`
webhook. Always treat `getSubscription` (mirror) as the truth for gating.

## 7. Reacting to changes — `onSubscriptionChange`

```ts
const off = billing(db).onSubscriptionChange((e) => {
  // e.type: "subscription.created" | "subscription.updated" | "subscription.canceled" | "payment.failed"
  // grant/revoke access, send your own email, etc.
});
```

> **Serverless caveat:** handlers are in-process — they fire only within the
> request/instance that handled the webhook, and **only if the webhook route is
> that same instance's `b.webhookHandler()`** (§5). The durable signal is the DB
> mirror; for cross-process reactions, read `getSubscription` (or run side effects
> inside the webhook request). Register handlers at module scope so each cold
> start re-registers them. A handler that throws is isolated — it never breaks
> the part's state or the webhook response.

## 8. Idempotency keys (recommended)

Pass `idempotencyKey` on `createCheckout` / `cancelAtPeriodEnd` / `changePlan`
(one per logical user action) so a retried request is safe.

## 9. What you must NOT do

- Edit anything under `src/` or `adapters/selected/`.
- Grant entitlement from the success redirect or any client input — only the
  verified webhook (the mirror) is authoritative.
- Add a body parser in front of the webhook route — it breaks signature verification.
- Store card data anywhere — the part deliberately never does, and never should you.
