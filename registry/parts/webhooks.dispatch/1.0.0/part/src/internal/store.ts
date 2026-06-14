import { DispatchError } from "./errors";
import { newEndpointId, newMessageId, newSecret } from "./ids";
import { signStandardWebhooks } from "./sign";
import {
  INSERT_ATTEMPT_SQL,
  INSERT_ENDPOINT_SQL,
  INSERT_OUTBOX_SQL,
  MARK_DEAD_SQL,
  MARK_DELIVERED_SQL,
  MARK_RETRY_SQL,
  rowToAttempt,
  rowToDue,
  SELECT_ATTEMPTS_SQL,
  SELECT_DUE_SQL,
  SELECT_ENDPOINT_SQL,
  SELECT_OUTBOX_BY_IDEM_SQL,
  type DueRow,
} from "./sql";
import { deliver, isPublicAddress, isTestAllowed } from "./ssrf";
import type {
  DeliverDueOptions,
  DeliveryAttempt,
  DeliveryOutcome,
  DeliveryReport,
  Dispatcher,
  DispatchInput,
  DispatchResult,
  RegisterEndpointInput,
  RegisteredEndpoint,
  SqlExecutor,
} from "./types";
import { validateDispatch, validateMessageId, validateRegister } from "./validate";

// Retry policy (contract invariant 4) — capped exponential backoff, bounded attempts.
const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_SECONDS = 60;
const BACKOFF_FACTOR = 2;
const MAX_BACKOFF_SECONDS = 3600;
const DELIVERY_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH = 50;
const MAX_BATCH = 1000;
// Bound a single drain pass so a run of slow endpoints can't make one pass take
// batch × timeout; remaining due rows are picked up by the next pass.
const MAX_PASS_MS = 30_000;

function backoffSeconds(attemptNo: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * BACKOFF_FACTOR ** (attemptNo - 1));
}

export function createDispatcher(db: SqlExecutor): Dispatcher {
  async function q(
    sql: string,
    params: readonly unknown[],
    action: string,
  ): Promise<{ rows: Record<string, unknown>[] }> {
    try {
      return await db.query(sql, params);
    } catch (e) {
      // Generic message; the raw driver error (possible credentials) stays on cause.
      throw new DispatchError("storage", `failed to ${action}`, { cause: e });
    }
  }

  async function registerEndpoint(input: RegisterEndpointInput): Promise<RegisteredEndpoint> {
    const v = validateRegister(input); // throws invalid_payload/invalid_url before any SQL/network

    let url: URL;
    try {
      url = new URL(v.url);
    } catch {
      throw new DispatchError("invalid_url", "url is not a valid URL");
    }
    // SSRF up-front rejection (advisory; the delivery-time gate is authoritative).
    if (!isTestAllowed(url.hostname)) {
      if (url.protocol !== "https:") {
        throw new DispatchError("invalid_url", "url must use https");
      }
      if (!(await isPublicAddress(url.hostname))) {
        throw new DispatchError("invalid_url", "url must resolve to a public address");
      }
    }

    const id = newEndpointId();
    const secret = newSecret();
    const res = await q(INSERT_ENDPOINT_SQL, [id, v.ownerId, v.url, secret, v.eventTypes], "register endpoint");
    if (res.rows[0] === undefined) {
      throw new DispatchError(
        "storage",
        "register returned no row — is the webhooks_dispatch migration applied?",
      );
    }
    return { id, secret }; // secret returned ONCE (contract invariant 7)
  }

  async function dispatch(input: DispatchInput): Promise<DispatchResult> {
    const v = validateDispatch(input); // throws invalid_payload before any SQL; serializes payload

    const ep = await q(SELECT_ENDPOINT_SQL, [v.endpointId], "dispatch");
    if (ep.rows[0] === undefined) {
      throw new DispatchError("unknown_endpoint", "no endpoint with that id");
    }

    const messageId = newMessageId();
    // Persist to the outbox and return — NEVER deliver inline (contract invariant 2).
    const ins = await q(
      INSERT_OUTBOX_SQL,
      [messageId, v.endpointId, v.eventType, v.payloadJson, v.idempotencyKey],
      "dispatch",
    );
    if (ins.rows[0] !== undefined) return { messageId };

    // Empty RETURNING ⟹ an idempotency-key conflict (a NULL key never conflicts).
    if (v.idempotencyKey !== null) {
      const existing = await q(
        SELECT_OUTBOX_BY_IDEM_SQL,
        [v.endpointId, v.idempotencyKey],
        "dispatch",
      );
      const row = existing.rows[0];
      if (row !== undefined) return { messageId: String(row["id"]) };
    }
    throw new DispatchError(
      "storage",
      "dispatch did not persist — is the webhooks_dispatch migration applied?",
    );
  }

  /** Attempt one due delivery; record the attempt and update the outbox row. */
  async function attemptDelivery(row: DueRow, now: Date): Promise<DeliveryOutcome> {
    const attemptNo = row.attemptCount + 1;
    // Sign with the ACTUAL send time, not the batch-start `now` — a sequential
    // batch with slow earlier rows would otherwise emit a stale timestamp that
    // the receiver rejects as out-of-window. (`now` is for backoff math only.)
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const body = Buffer.from(row.payload, "utf8");
    // Re-sign with the CURRENT timestamp on every attempt (contract invariant 3).
    const signed = signStandardWebhooks({ id: row.id, payload: body, secret: row.secret, timestampSeconds });

    const result = await deliver(
      row.url,
      body,
      { ...signed, "content-type": "application/json" },
      { timeoutMs: DELIVERY_TIMEOUT_MS },
    );

    let outcome: DeliveryOutcome;
    let statusCode: number | null = null;
    let nextAttemptAt: Date | null = null;
    let error: string | null = null;
    const latencyMs = result.latencyMs;

    if (result.kind === "response") {
      statusCode = result.statusCode;
      if (result.statusCode >= 200 && result.statusCode < 300) {
        outcome = "delivered";
      } else if (result.statusCode === 429 || result.statusCode >= 500) {
        // transient — retry unless exhausted
        if (attemptNo >= MAX_ATTEMPTS) {
          outcome = "dead";
          error = `http ${result.statusCode} (exhausted)`;
        } else {
          const delay =
            result.statusCode === 429 && result.retryAfterSeconds !== null
              ? result.retryAfterSeconds // Retry-After overrides computed backoff
              : backoffSeconds(attemptNo);
          nextAttemptAt = new Date(now.getTime() + delay * 1000);
          outcome = "retrying";
          error = `http ${result.statusCode}`;
        }
      } else {
        // 4xx (except 429) — permanent, not retried
        outcome = "dead";
        error = `http ${result.statusCode} (permanent)`;
      }
    } else {
      // network error or SSRF block — transient, retry unless exhausted
      error = result.error;
      if (attemptNo >= MAX_ATTEMPTS) {
        outcome = "dead";
      } else {
        nextAttemptAt = new Date(now.getTime() + backoffSeconds(attemptNo) * 1000);
        outcome = "retrying";
      }
    }

    await q(
      INSERT_ATTEMPT_SQL,
      [row.id, attemptNo, now, statusCode, outcome, latencyMs, nextAttemptAt, error],
      "record delivery attempt",
    );
    if (outcome === "delivered") {
      await q(MARK_DELIVERED_SQL, [row.id, attemptNo, now], "mark delivered");
    } else if (outcome === "retrying") {
      await q(MARK_RETRY_SQL, [row.id, attemptNo, nextAttemptAt], "reschedule delivery");
    } else {
      await q(MARK_DEAD_SQL, [row.id, attemptNo], "dead-letter delivery");
    }
    return outcome;
  }

  async function deliverDue(opts?: DeliverDueOptions): Promise<DeliveryReport> {
    const now = opts?.now ?? new Date();
    const batch = opts?.batch ?? DEFAULT_BATCH;
    if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) {
      throw new DispatchError("invalid_payload", `batch must be an integer in 1..${MAX_BATCH}`);
    }
    const due = await q(SELECT_DUE_SQL, [now, batch], "select due deliveries");
    const report: DeliveryReport = { attempted: 0, delivered: 0, retried: 0, dead: 0 };
    const passStart = Date.now();
    for (const raw of due.rows) {
      // Stop pulling new rows once the pass budget is spent — a backlog of slow
      // endpoints can't starve the next tick; their rows stay due for it.
      if (Date.now() - passStart > MAX_PASS_MS) break;
      // Sequential: works with a single pg Client or a Pool, and never stampedes
      // a customer endpoint. eslint-disable-next-line no-await-in-loop
      const outcome = await attemptDelivery(rowToDue(raw), now);
      report.attempted += 1;
      if (outcome === "delivered") report.delivered += 1;
      else if (outcome === "retrying") report.retried += 1;
      else report.dead += 1;
    }
    return report;
  }

  async function listAttempts(messageId: string): Promise<DeliveryAttempt[]> {
    const v = validateMessageId(messageId);
    const res = await q(SELECT_ATTEMPTS_SQL, [v], "list attempts");
    return res.rows.map(rowToAttempt);
  }

  return { registerEndpoint, dispatch, deliverDue, listAttempts };
}
