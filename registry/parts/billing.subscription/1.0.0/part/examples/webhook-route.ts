/**
 * Example: mount the inbound webhook handler. The handler verifies the Stripe
 * signature over the RAW request bytes, so the route MUST NOT pre-parse the
 * body. Outside the part boundary — edit freely.
 *
 * Next.js App Router — app/api/webhooks/billing/route.ts:
 *   import { db } from "@/lib/db";
 *   import { billing } from "@/parts/billing.subscription/src/index";
 *   const b = billing(db);
 *   b.onSubscriptionChange((e) => { ... grant/revoke access ... });
 *   export const POST = b.webhookHandler();   // same instance → handlers fire; raw Request preserved
 *
 * No handlers? The standalone shortcut works too:
 *   export const POST = billingWebhookHandler(db);
 *
 * Express:
 *   app.post("/api/webhooks/billing",
 *     express.raw({ type: "application/json" }),       // RAW body, BEFORE express.json()
 *     async (req, res) => {
 *       const r = await handler(new Request("http://x", { method: "POST", body: req.body, headers: req.headers as any }));
 *       res.status(r.status).send(await r.text());
 *     });
 *
 * Configure the Stripe dashboard endpoint to send exactly: checkout.session.completed,
 * customer.subscription.created, customer.subscription.updated,
 * customer.subscription.deleted, invoice.paid, invoice.payment_failed.
 */
import { billingWebhookHandler, type SqlExecutor } from "../src/index";

export function makeBillingRoute(db: SqlExecutor): (request: Request) => Promise<Response> {
  return billingWebhookHandler(db);
}
