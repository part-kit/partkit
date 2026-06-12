/**
 * EXAMPLE SEAM — this file is OUTSIDE the boundary: copy it into your app as
 * app/api/webhooks/ingest/route.ts and edit freely. It is not attested.
 *
 * After copying, change the import to your alias (seams.md §2):
 *   import { onWebhook, webhookHandler } from "@parts/webhooks.ingest";
 */
import { onWebhook, webhookHandler, type VerifiedWebhook } from "../src/index";

/**
 * Module-scope registration is re-evaluated on every cold start — the
 * serverless-sanctioned subscription form. Register here, in the same module
 * that mounts the handler, so a mounted route can never exist without its
 * handlers.
 *
 * event.payload is the raw verified body; parsing it and dispatching on your
 * vendor's event types is YOUR domain — the part only guarantees authenticity.
 */
onWebhook(async (event: VerifiedWebhook) => {
  const body = JSON.parse(event.payload) as { type?: string };
  switch (body.type) {
    case "invoice.paid":
      // await markInvoicePaid(body) — your app code goes here
      break;
    default:
      // Ignoring unhandled event types is correct: acknowledging them (2xx)
      // is what stops the vendor from redelivering forever.
      break;
  }
});

/** The one-line mount (contract http_routes): POST /api/webhooks/ingest. */
export const POST = webhookHandler;
