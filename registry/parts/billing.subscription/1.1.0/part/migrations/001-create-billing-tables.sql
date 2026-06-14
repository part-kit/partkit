-- billing.subscription @ 1.0.0 — migration 001
-- Part-owned tables (docs/02 §6): everything here is prefixed `billing_`, so it
-- never collides with app tables and the boundary is visible in the DB.
-- Transactional (no -- partkit:no-transaction directive): the whole migration
-- commits or rolls back as one unit.
--
-- State is derived solely from verified Stripe webhook events; NO card data is
-- ever stored. Primary keys are app-assigned UUID strings (crypto.randomUUID(),
-- stored as text — the auth.tenancy convention) so the part needs no DB uuid
-- extension and runs on plain Postgres.

-- One thin subscription mirror per vendor subscription, keyed by the opaque
-- user_id (no FK to any auth.session table — the part never owns the principal).
CREATE TABLE billing_subscriptions (
  id                     text        NOT NULL PRIMARY KEY,
  user_id                text        NOT NULL CHECK (length(user_id) > 0),
  stripe_customer_id     text        NOT NULL,
  stripe_subscription_id text        NOT NULL UNIQUE,
  stripe_price_id        text        NOT NULL,
  -- The app's own plan id, carried through Stripe subscription metadata at
  -- checkout (subscription_data.metadata.plan_id). Nullable: a subscription
  -- created outside our checkout (e.g. directly via the API) carries no plan id.
  plan_id                text,
  -- Free text, deliberately NOT a CHECK enum: a future Stripe status must never
  -- 500 the webhook (a rejected row would make Stripe redeliver forever — a
  -- poison event). Entitlement is computed safely (status ∈ {active,trialing});
  -- any unknown status is simply not entitled.
  status                 text        NOT NULL,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean     NOT NULL DEFAULT false,
  -- The emitting event's timestamp (Stripe event.created). Guards the upsert so
  -- an out-of-order/redelivered OLDER event can't overwrite newer state.
  last_event_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_subscriptions_user_id_idx  ON billing_subscriptions (user_id);
CREATE INDEX billing_subscriptions_customer_idx ON billing_subscriptions (stripe_customer_id);

-- Append-only webhook idempotency ledger. The UNIQUE on stripe_event_id is the
-- dedupe storage: a redelivered evt_ is recorded and applied at most once. No
-- raw-payload column — only the vendor event id, type, and receipt time are kept
-- (invariant: no card data / sensitive payload stored).
CREATE TABLE billing_events (
  id              text        NOT NULL PRIMARY KEY,
  stripe_event_id text        NOT NULL UNIQUE,
  type            text        NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_events_type_idx ON billing_events (type);

-- Enforce append-only on the ledger in the database itself (the audit.log
-- pattern): block UPDATE/DELETE so an idempotency record can never be silently
-- mutated or dropped to force reprocessing.
CREATE OR REPLACE FUNCTION billing_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'billing_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_events_no_mutate
  BEFORE UPDATE OR DELETE ON billing_events
  FOR EACH ROW EXECUTE FUNCTION billing_events_append_only();

-- TRUNCATE bypasses row triggers, so guard it at statement level too (the
-- audit.log pattern) — the ledger is unrewritable even via TRUNCATE.
CREATE TRIGGER billing_events_no_truncate
  BEFORE TRUNCATE ON billing_events
  FOR EACH STATEMENT EXECUTE FUNCTION billing_events_append_only();
