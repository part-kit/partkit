-- billing.usage @ 1.0.0 — migration 001
-- Part-owned table (docs/02 §6): prefixed `billing_usage_`, so it never collides
-- with app tables and the boundary is visible in the DB. Transactional (no
-- -- partkit:no-transaction directive): commits or rolls back as one unit.

CREATE TABLE billing_usage_events (
  -- App-assigned id (ue_…), the stable biller idempotency key — known at insert
  -- time and opaque, so reporting is exactly-once (contract invariant 4).
  id              text         NOT NULL PRIMARY KEY,
  -- Internal monotonic cursor — the drain orders by this; never exposed.
  seq             bigint       GENERATED ALWAYS AS IDENTITY,
  -- The billable principal — a customer/org id OR an auth.apikey id. Opaque.
  subject_id      text         NOT NULL CHECK (length(subject_id) > 0),
  meter           text         NOT NULL CHECK (length(meter) > 0),
  -- NUMERIC (not double): integers round-trip exactly, decimals representable
  -- (contract invariant 5). node-postgres returns it as a string.
  quantity        numeric      NOT NULL CHECK (quantity >= 0),
  -- Event time (caller-settable, supports backfill); total/summary window on this.
  occurred_at     timestamptz  NOT NULL DEFAULT now(),
  -- Dedupe scope is (subject_id, meter, idempotency_key); a NULL key never
  -- conflicts (Postgres treats NULLs as distinct) = the "no dedupe" path.
  idempotency_key text,
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  -- The reporting-drain state. NULL = unreported; reportDue marks it. The table
  -- is NOT append-only: reportDue UPDATEs reported_at.
  reported_at     timestamptz,
  reported_id     text,
  -- Failed report attempts. The drain orders by this ASC so a permanently-
  -- rejected event (e.g. a bad biller mapping) sinks to the back and can never
  -- starve fresh, never-failed usage (head-of-line-blocking guard).
  report_attempts integer      NOT NULL DEFAULT 0,
  -- Server insert time, never caller-settable (forensics; distinct from occurred_at).
  created_at      timestamptz  NOT NULL DEFAULT now(),

  UNIQUE (subject_id, meter, idempotency_key)
);

-- Aggregation hot path: total()/summary() scan one subject's window per meter.
CREATE INDEX billing_usage_events_subject_meter_time_idx
  ON billing_usage_events (subject_id, meter, occurred_at);

-- Drain hot path: unreported rows, fewest-failures-then-oldest first. Partial
-- index stays small as the reported backlog grows.
CREATE INDEX billing_usage_events_unreported_idx
  ON billing_usage_events (report_attempts, seq)
  WHERE reported_at IS NULL;
