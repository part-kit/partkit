-- search.fulltext @ 1.0.0 — migration 001
-- Part-owned table (docs/02 §6): prefixed `search_`, so it never collides with
-- app tables and the boundary is visible in the DB. Transactional.

CREATE TABLE search_documents (
  ref       text         PRIMARY KEY CHECK (length(ref) > 0),  -- the app's document id (upsert key)
  type      text,                                              -- bucket for filtering (listing/post/…)
  title     text,                                              -- weighted A (higher than body)
  body      text         NOT NULL CHECK (length(body) > 0),    -- weighted B
  metadata  jsonb        NOT NULL DEFAULT '{}'::jsonb,         -- returned verbatim; NOT searched
  -- A STORED generated column so the vector can never drift from the row — no
  -- trigger needed. The config MUST be the literal 'english' (the 2-arg
  -- to_tsvector is IMMUTABLE only with a constant config; the 1-arg form depends
  -- on a session GUC and is rejected in a generated column).
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body,  '')), 'B')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- GIN index is what the @@ match operator uses (confirmed via EXPLAIN).
CREATE INDEX search_documents_vector_idx ON search_documents USING GIN (search_vector);

-- Type filter is common; a partial-free btree keeps it cheap alongside the GIN scan.
CREATE INDEX search_documents_type_idx ON search_documents (type) WHERE type IS NOT NULL;
