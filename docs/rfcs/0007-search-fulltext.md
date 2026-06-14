# RFC 0007 — `search.fulltext` capability

**Status:** accepted 2026-06-14 (chief-architect session; capability already in the docs/02 namespace, this RFC specifies its interface)
**Adds capability:** `search.fulltext@1`
**Unblocks:** the `marketplace` App Pack (with `flags.feature`) — listings/content search without a separate search vendor
**Composes with:** any part/app that produces documents to index; no `requires` edge
**Author:** chief-architect session, 2026-06-14

## 1. Problem

Content and marketplace products need search, and the reflex is to bolt on
Elasticsearch/Algolia/Typesense — a second datastore to run, sync, secure, and
pay for, often before there's enough content to justify it. Meanwhile Postgres
ships a capable full-text engine that most apps never reach for because the SQL
is fiddly: which `to_tsquery` variant is safe for raw user input, how to weight
title over body, how to rank, how to keep the `tsvector` in sync, which index.
Hand-rolled, it breaks: `to_tsquery` throws on a user typing `foo:`, the vector
drifts from the row, no ranking, a sequential scan.

`search.fulltext` is the verified Postgres-native search primitive: index
documents, search them with raw user query strings safely, ranked, with
title-over-body weighting and highlighted snippets — on plain Postgres, no extra
vendor. (A dedicated engine becomes a *second part* providing `search.fulltext@1`
later — capability-level interchange, not an adapter axis.)

## 2. Interface (`search.fulltext@1`)

```ts
search(db: SqlExecutor): SearchIndex

interface SearchIndex {
  // Upsert a document by its app-owned ref. Re-indexing the same ref replaces it.
  index(doc: IndexDocInput): Promise<void>;
  // Remove a document (idempotent — removing an absent ref is a no-op).
  remove(ref: string): Promise<void>;
  // Ranked full-text search over a RAW user query string. Never throws on syntax.
  query(input: SearchQuery): Promise<SearchResult[]>;
}

interface IndexDocInput {
  ref: string;                          // the app's document id (opaque, the upsert key)
  type?: string;                        // a bucket for filtering (e.g. "listing", "post")
  title?: string;                       // weighted higher than body
  body: string;                         // the main text
  metadata?: Record<string, unknown>;   // returned verbatim with results, NOT searched
}

interface SearchQuery {
  q: string;                            // raw user input — quotes, OR, -negation handled safely
  type?: string;                        // restrict to one type
  limit?: number;                       // 1..100, default 20
  offset?: number;                      // for pagination
}

interface SearchResult {
  ref: string;
  type: string | null;
  title: string | null;
  rank: number;                         // relevance score (higher = better)
  snippet: string;                      // highlighted excerpt around the match
  metadata: Record<string, unknown>;
}

class SearchError extends Error { code: "invalid_input" | "storage" }
```

Owns the `search_documents` table (forward-only migrations, `partkit migrate`).
Zero npm dependencies — it is pure Postgres FTS through the `SqlExecutor` seam.

## 3. Invariants (each maps to ≥1 conformance test)

1. Importing performs no I/O and never throws; `index`/`query` validate input with a typed `SearchError`, and storage failures surface as `SearchError("storage")` (raw driver errors never escape).
2. **`index` upserts by `ref`** — re-indexing the same `ref` replaces the document (never a duplicate); `remove` is idempotent.
3. **`query` accepts a RAW user query string and never throws on syntax** — operators, quotes, an unbalanced `:` or `&`, accents — are handled as a search expression (via `websearch_to_tsquery`), not as `tsquery` syntax that can error.
4. Results are **ranked by relevance** (`ts_rank`), **title outranks body** (weighted A vs B), filtered by `type`, paginated by `limit`/`offset`, and each carries a **highlighted snippet** of the match.
5. A query that matches nothing returns an empty array (not an error); a query matching multiple docs returns them best-first, deterministically.
6. The part operates solely through the `SqlExecutor` seam (no driver import); every statement targets only `search_documents`, and all inputs — including the query string — are parameterized (no injection, even though FTS parsing is involved).

## 4. Implementation notes for the part author

- **The vector is a stored generated column**, so it can never drift from the row:
  `search_vector tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title,'')), 'A') || setweight(to_tsvector('english', coalesce(body,'')), 'B')) STORED`, with a **GIN index** on it. The text-search config must be a constant (`'english'`) for the generated column to be immutable.
- **Use `websearch_to_tsquery('english', $q)`** for the query — it is the only variant designed for raw end-user input (it never raises a syntax error and supports quoted phrases, `or`, and `-` negation), unlike `to_tsquery` (throws) or `plainto_tsquery` (no operators). Rank with `ts_rank(search_vector, query)`; snippet with `ts_headline('english', coalesce(title||' — '||body, body), query, 'MaxFragments=1, ...')`.
- DB-backed → `audit.log` conformance pattern: indexing/upsert, ranked search, weighting, raw-query safety (feed punctuation/operators), type filter, pagination, and injection against real Postgres gated on `PARTKIT_TEST_DATABASE_URL`; input validation and typed errors run DB-free.
- One table, `search_documents`: `ref text PRIMARY KEY`, `type text`, `title text`, `body text`, `metadata jsonb`, the generated `search_vector`, timestamps. `index` is `INSERT … ON CONFLICT (ref) DO UPDATE`. Keep the language config fixed at `english` in v1 (a configurable regconfig is a future minor).

## 5. Roadmap (not v1)

- Configurable language / per-document language.
- Trigram / fuzzy matching (`pg_trgm`) for typo tolerance as an additive option.
- Faceting/aggregations over `type`/metadata.
- A dedicated-engine second provider (Typesense/Meilisearch) of `search.fulltext@1` if Postgres FTS is outgrown.
