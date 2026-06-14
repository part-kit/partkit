/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * Gate a feature in a request handler, and define a flag from an admin action.
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { flags, type SqlExecutor } from "@parts/flags.feature";
 */
import { flags, type SqlExecutor } from "../src/index";

/**
 * Gate a feature on the request path. evaluate NEVER throws — pass your
 * compiled-in default as the fallback, so a flag-store hiccup degrades safely.
 */
export async function isNewCheckoutOn(
  db: SqlExecutor,
  user: { id: string; plan: string },
): Promise<boolean> {
  return flags(db).evaluate(
    "new-checkout",
    { subjectId: user.id, attributes: { plan: user.plan } },
    false, // fallback
  );
}

/** Bootstrap every flag for a client in one query (e.g. inject into an SPA). */
export function flagsForClient(
  db: SqlExecutor,
  user: { id: string; plan: string },
): Promise<Record<string, unknown>> {
  return flags(db).evaluateAll({ subjectId: user.id, attributes: { plan: user.plan } });
}

/** Define / update a flag from an admin action: 10% sticky rollout, enterprise on. */
export async function defineNewCheckout(db: SqlExecutor): Promise<void> {
  await flags(db).setFlag({
    key: "new-checkout",
    type: "boolean",
    enabled: true,
    default: false,
    rules: [{ conditions: [{ attribute: "plan", op: "eq", value: "enterprise" }], variant: true }],
    rollout: [
      { value: true, weight: 10 },
      { value: false, weight: 90 },
    ],
  });
}
