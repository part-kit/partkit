/**
 * Example PlanCatalog — the seam where YOUR app maps its plan ids to Stripe
 * price ids. Copy this into your app and replace the price id(s) with real
 * `price_…` values from your Stripe dashboard. Outside the part boundary —
 * edit freely.
 */
import type { Plan, PlanCatalog } from "../src/index";

const PLANS: Plan[] = [
  { id: "pro", stripePriceId: "price_REPLACE_ME", label: "Pro" },
  // { id: "team", stripePriceId: "price_REPLACE_ME_TOO", label: "Team" },
];

export const planCatalog: PlanCatalog = {
  get: (id) => PLANS.find((p) => p.id === id) ?? null,
  list: () => PLANS,
};
