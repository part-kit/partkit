-- audit.log @ 1.0.0 — migration 001
-- Part-owned table (docs/02 §6): everything here is prefixed `audit_events`,
-- so it never collides with app tables and the boundary is visible in the DB.
-- Transactional (no -- partkit:no-transaction directive): the whole migration
-- commits or rolls back as one unit.

CREATE TABLE audit_events (
  id          bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Server-assigned timeline. occurred_at is NOT caller-settable through the
  -- part: a trustworthy order of events is the point of an audit log.
  occurred_at timestamptz   NOT NULL DEFAULT now(),
  actor       text,                              -- who (null = system / anonymous)
  action      text          NOT NULL CHECK (length(action) > 0),  -- what, e.g. "user.login"
  target      text,                              -- the object acted upon (optional)
  metadata    jsonb         NOT NULL DEFAULT '{}'::jsonb
);

-- Read paths: newest-first scans and per-dimension filters.
CREATE INDEX audit_events_id_desc_idx ON audit_events (id DESC);
CREATE INDEX audit_events_actor_idx   ON audit_events (actor)  WHERE actor  IS NOT NULL;
CREATE INDEX audit_events_action_idx  ON audit_events (action);
CREATE INDEX audit_events_target_idx  ON audit_events (target) WHERE target IS NOT NULL;
CREATE INDEX audit_events_occurred_idx ON audit_events (occurred_at);

-- Append-only, enforced by the database itself — not just by withholding a
-- mutator from the interface. Even a direct UPDATE/DELETE with table access is
-- refused, so the trail cannot be quietly rewritten (contract invariant 3).
CREATE FUNCTION audit_events_block_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();

-- TRUNCATE is neither UPDATE nor DELETE, so it needs its own statement-level
-- trigger — otherwise the whole trail could be wiped in one statement.
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_block_mutation();
