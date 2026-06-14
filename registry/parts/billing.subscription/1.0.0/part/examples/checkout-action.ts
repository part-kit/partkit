/**
 * Example: start a subscription checkout from a server action / route, then send
 * the user to Stripe's hosted page. The mirror is NOT written here — it appears
 * once the verified webhook arrives, so the success page must not grant access
 * on its own. Outside the part boundary — edit freely.
 *
 * Next.js App Router server action:
 *   "use server";
 *   import { redirect } from "next/navigation";
 *   import { db } from "@/lib/db";          // pgExecutor(pool)
 *   import { planCatalog } from "@/lib/plans";
 *   export async function subscribe(userId: string, planId: string) {
 *     redirect(await startCheckout(db, planCatalog, userId, planId));
 *   }
 */
import { billing, type PlanCatalog, type SqlExecutor } from "../src/index";

export async function startCheckout(
  db: SqlExecutor,
  catalog: PlanCatalog,
  userId: string,
  planId: string,
): Promise<string> {
  const session = await billing(db).createCheckout({
    userId,
    planId,
    catalog,
    successUrl: "https://example.com/billing/success?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://example.com/billing",
  });
  return session.url; // redirect(...) to this in your framework
}
