/**
 * EXAMPLE SEAM — OUTSIDE the boundary: copy into your app and edit freely.
 * Shows the two operations: append an event, then read the trail back.
 *
 * After copying, change the imports to your alias (seams.md §1):
 *   import { auditLog } from "@parts/audit.log";
 */
import { auditLog, type AuditEvent, type SqlExecutor } from "../src/index.js";

/** Record a sign-in. Call this from your auth handler after a successful login. */
export async function recordLogin(
  db: SqlExecutor,
  userId: string,
  ip: string,
): Promise<AuditEvent> {
  const log = auditLog(db);
  return log.append({
    actor: userId,
    action: "user.login",
    metadata: { ip }, // occurred_at is server-assigned — don't pass timestamps here
  });
}

/** Newest 50 actions a given user took — your "account activity" page. */
export async function recentActivity(db: SqlExecutor, userId: string): Promise<AuditEvent[]> {
  const log = auditLog(db);
  return log.query({ actor: userId, limit: 50 });
}
