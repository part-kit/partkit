import { randomUUID } from "node:crypto";
import { redactSecrets } from "./config";
import { BillingError } from "./errors";
import {
  INSERT_EVENT_SQL,
  SELECT_SUBSCRIPTION_BY_ID_SQL,
  SELECT_SUBSCRIPTION_BY_USER_SQL,
  SELECT_SUBSCRIPTION_BY_VENDOR_ID_SQL,
  UPSERT_SUBSCRIPTION_SQL,
} from "./sql";
import type { SqlExecutor, SubscriptionStatus } from "./types";

export interface UpsertInput {
  userId: string;
  vendorCustomerId: string;
  vendorSubscriptionId: string;
  vendorPriceId: string;
  planId: string | null;
  status: SubscriptionStatus;
  currentPeriodEndEpoch: number | null;
  cancelAtPeriodEnd: boolean;
  /** The emitting event's Unix timestamp — guards against out-of-order writes. */
  lastEventEpoch: number;
}

type Row = Record<string, unknown>;

/** Thin DB layer over the SqlExecutor seam. Every error is wrapped + redacted. */
export class BillingStore {
  constructor(private readonly db: SqlExecutor) {}

  private async run(sql: string, params: readonly unknown[]): Promise<{ rows: Row[] }> {
    try {
      return await this.db.query(sql, params);
    } catch (e) {
      throw new BillingError("storage", redactSecrets(e instanceof Error ? e.message : String(e)));
    }
  }

  async upsertSubscription(input: UpsertInput): Promise<Row> {
    const { rows } = await this.run(UPSERT_SUBSCRIPTION_SQL, [
      randomUUID(),
      input.userId,
      input.vendorCustomerId,
      input.vendorSubscriptionId,
      input.vendorPriceId,
      input.planId,
      input.status,
      input.currentPeriodEndEpoch,
      input.cancelAtPeriodEnd,
      input.lastEventEpoch,
    ]);
    const row = rows[0];
    if (row === undefined) throw new BillingError("storage", "upsert returned no row");
    return row;
  }

  async getByUser(userId: string): Promise<Row | null> {
    const { rows } = await this.run(SELECT_SUBSCRIPTION_BY_USER_SQL, [userId]);
    return rows[0] ?? null;
  }

  async getById(id: string): Promise<Row | null> {
    const { rows } = await this.run(SELECT_SUBSCRIPTION_BY_ID_SQL, [id]);
    return rows[0] ?? null;
  }

  async getByVendorId(vendorSubscriptionId: string): Promise<Row | null> {
    const { rows } = await this.run(SELECT_SUBSCRIPTION_BY_VENDOR_ID_SQL, [vendorSubscriptionId]);
    return rows[0] ?? null;
  }

  /** Record a vendor event id once. Returns true if newly recorded, false if it
   *  was already present (a duplicate delivery) — the idempotency gate. */
  async markEventProcessed(eventId: string, type: string): Promise<boolean> {
    const { rows } = await this.run(INSERT_EVENT_SQL, [randomUUID(), eventId, type]);
    return rows.length > 0;
  }
}
