/**
 * Constant, fully-parameterized statements (the audit.log / auth.tenancy
 * pattern). Every statement targets ONLY billing_subscriptions or
 * billing_events; ids and values are always bound params ($n), never
 * interpolated, so SQL metacharacters are stored literally.
 */

/** Upsert the subscription mirror, keyed by the vendor subscription id, GUARDED
 *  by the emitting event's timestamp so an out-of-order/older event cannot
 *  overwrite newer state. On a redelivery/update customer/user/created_at are
 *  preserved; only the lifecycle fields change. Params: $8 = Unix period-end
 *  (or null), $10 = Unix event timestamp (event.created). The CTE always
 *  returns the resulting row — the freshly-written one, or the existing (newer)
 *  row when the guard skips a stale update — so the caller never sees an empty
 *  result on a legitimate conflict. */
export const UPSERT_SUBSCRIPTION_SQL = `
  WITH upserted AS (
    INSERT INTO billing_subscriptions
      (id, user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
       plan_id, status, current_period_end, cancel_at_period_end,
       last_event_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5,
       $6, $7, to_timestamp($8::double precision), $9,
       to_timestamp($10::double precision), now())
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET
      stripe_price_id      = EXCLUDED.stripe_price_id,
      plan_id              = COALESCE(EXCLUDED.plan_id, billing_subscriptions.plan_id),
      status               = EXCLUDED.status,
      current_period_end   = EXCLUDED.current_period_end,
      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      last_event_at        = EXCLUDED.last_event_at,
      updated_at           = now()
    WHERE billing_subscriptions.last_event_at IS NULL
       OR EXCLUDED.last_event_at IS NULL
       OR EXCLUDED.last_event_at >= billing_subscriptions.last_event_at
    RETURNING *
  )
  SELECT * FROM upserted
  UNION ALL
  SELECT * FROM billing_subscriptions
    WHERE stripe_subscription_id = $4 AND NOT EXISTS (SELECT 1 FROM upserted)
  LIMIT 1;`;

export const SELECT_SUBSCRIPTION_BY_USER_SQL = `
  SELECT * FROM billing_subscriptions
  WHERE user_id = $1
  ORDER BY created_at DESC
  LIMIT 1;`;

export const SELECT_SUBSCRIPTION_BY_ID_SQL = `
  SELECT * FROM billing_subscriptions WHERE id = $1;`;

export const SELECT_SUBSCRIPTION_BY_VENDOR_ID_SQL = `
  SELECT * FROM billing_subscriptions WHERE stripe_subscription_id = $1;`;

/** Idempotency: insert succeeds once per vendor event id. ON CONFLICT DO NOTHING
 *  + RETURNING lets the caller detect "already processed" (zero rows back). */
export const INSERT_EVENT_SQL = `
  INSERT INTO billing_events (id, stripe_event_id, type)
  VALUES ($1, $2, $3)
  ON CONFLICT (stripe_event_id) DO NOTHING
  RETURNING id;`;
