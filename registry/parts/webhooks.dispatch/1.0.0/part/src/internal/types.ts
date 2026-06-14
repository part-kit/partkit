/**
 * The driver-free database seam — the same minimal `node-postgres` Client/Pool
 * shape `partkit migrate` uses. The app wires its own `pg` Pool to this; the
 * part imports no driver (contract invariant 8). Wiring example: seams.md §2.
 */
export interface SqlExecutor {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Register a customer destination. The secret is returned ONCE (invariant 7). */
export interface RegisterEndpointInput {
  /** The principal that owns this endpoint (a user/org id from your app). Opaque. */
  ownerId: string;
  /** Destination URL — validated https + public-address-only (invariant 6). */
  url: string;
  /** Event types this endpoint wants. Omitted/null = all (informational in v1). */
  eventTypes?: string[];
}

export interface RegisteredEndpoint {
  /** Stable handle (ep_…) used as dispatch's endpointId. */
  id: string;
  /**
   * The signing secret, `whsec_<base64>`. Returned ONCE — show it to the
   * endpoint owner so they can verify deliveries, then forget it. The receiver
   * verifies our Standard Webhooks signature with this same secret.
   */
  secret: string;
}

/** Enqueue an outbound event. Returns immediately; delivery is out-of-band. */
export interface DispatchInput {
  endpointId: string;
  /** e.g. "invoice.paid" — your event taxonomy. */
  eventType: string;
  /** JSON-serializable payload. Signed and sent as the exact serialized bytes. */
  payload: unknown;
  /** Dedupe re-enqueues of the same logical event → one outbox row (invariant 5). */
  idempotencyKey?: string;
}

export interface DispatchResult {
  /** The outbox id; also the stable `webhook-id` the receiver dedupes on. */
  messageId: string;
}

export interface DeliverDueOptions {
  /** Injected clock for backoff windows (defaults to the real now). */
  now?: Date;
  /** Max outbox rows to attempt this pass (default 50). */
  batch?: number;
}

export interface DeliveryReport {
  /** Rows attempted this pass. */
  attempted: number;
  /** Newly delivered (2xx). */
  delivered: number;
  /** Rescheduled for a later retry. */
  retried: number;
  /** Moved to dead-letter this pass (exhausted or permanent failure). */
  dead: number;
}

/** delivered = 2xx · retrying = transient, will retry · dead = exhausted/permanent. */
export type DeliveryOutcome = "delivered" | "retrying" | "dead";

/** One row of the delivery log — never includes secret material or internal IPs. */
export interface DeliveryAttempt {
  messageId: string;
  attemptNo: number;
  attemptedAt: Date;
  /** HTTP status, or null for a network error / blocked address. */
  statusCode: number | null;
  outcome: DeliveryOutcome;
  /** Round-trip latency in ms, or null if the request never completed. */
  latencyMs: number | null;
  /** When the next retry is scheduled, or null if terminal. */
  nextAttemptAt: Date | null;
  /** Generic cause; never a secret or a resolved internal IP. */
  error: string | null;
}

export interface Dispatcher {
  registerEndpoint(input: RegisterEndpointInput): Promise<RegisteredEndpoint>;
  dispatch(input: DispatchInput): Promise<DispatchResult>;
  deliverDue(opts?: DeliverDueOptions): Promise<DeliveryReport>;
  listAttempts(messageId: string): Promise<DeliveryAttempt[]>;
}
