# search.fulltext — design notes & threat model

`search.fulltext` is the verified Postgres-native search primitive: index
documents, then search them with raw user query strings safely, ranked
(title over body) with highlighted snippets — on plain Postgres, no separate
search vendor. Zero-dependency, driver-free via the `SqlExecutor` seam; owns one
table, `search_documents`, and reads no env. (A dedicated engine —
Typesense/Meilisearch — would be a *second part* providing `search.fulltext@1`,
capability-level interchange, not an adapter axis.)

## The index can't drift from the data

`search_documents.search_vector` is a **stored generated column**:
`setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
setweight(to_tsvector('english', coalesce(body,'')), 'B')`, with a **GIN** index.
Postgres recomputes it on every row write, so the vector is always consistent
with `title`/`body` — there is no trigger to forget and no out-of-band sync to
fall behind. `index` is an `INSERT … ON CONFLICT (ref) DO UPDATE`, so re-indexing
a `ref` replaces it (never a duplicate); the vector regenerates automatically.
The config is the literal `'english'` because a generated column must be
immutable (the 1-arg `to_tsvector` depends on a session GUC and is rejected).

## Raw user input is safe by construction

`query` parses `q` with **`websearch_to_tsquery('english', $1)`** — the one
tsquery parser designed for end-user input. It never raises a syntax error on
arbitrary text (stray `:`/`&`, unbalanced quotes, dangling operators, `(foo`,
`:*`), while still supporting quoted phrases, `or`, and `-negation`. `to_tsquery`
would throw on that input and `plainto_tsquery` would drop the operators. The raw
query is always a **bound parameter**, parsed server-side, so there is no
injection surface even though FTS parsing is involved.

## Ranking, snippets, pagination

Results are ordered by `ts_rank(search_vector, query)` (term-frequency ranking
that honors the A/B weights, so a title match outranks a body match — measured
0.61 vs 0.24), with a stable `ref` secondary sort so equal-rank results paginate
deterministically (no row appears on two pages). The expensive `ts_headline`
snippet is computed only for the returned page (the inner subquery filters + ranks
+ limits first), not the whole match set — **and** over a `left(…, 8192)` slice of
each page row, never the full body. That second cap matters: scoping to the page
bounds the *row count* but not the *per-row* cost, and `ts_headline` is O(document
size); since high term-frequency ranks large bodies to the top, an uncapped
headline lets one request burn seconds of CPU on a page of ~1 MB bodies (worse for
a phrase query). The 8 KB input cap makes per-row cost O(const) — ~100× cheaper on
large bodies, measured against real Postgres — while `MaxFragments=1`/`MaxWords=20`
means the snippet only ever needed a small window around the first match anyway, so
quality is unchanged. An empty/whitespace query short-circuits to `[]` before any
round-trip.

## <a id="threat-model"></a>Threat model

| Threat | Mitigation |
|---|---|
| **A crafted search string crashes the endpoint** | `websearch_to_tsquery` never raises on raw input; the empty query short-circuits to `[]`. A malformed search is never an error. |
| **SQL injection via query / ref / title / body / metadata** | Every statement is constant with positional parameters — including the raw query string, parsed server-side by `websearch_to_tsquery`; every statement touches only `search_documents`. Metacharacters round-trip as data. |
| **A NUL byte (U+0000) escapes validation → a storage 500** | Postgres rejects a NUL in any text/jsonb param at the encoding layer (SQLSTATE 22021/22P05) *before* `websearch_to_tsquery` runs, which would surface as `SearchError("storage")` and break the "never throws on raw input" guarantee. `validate` rejects a NUL in `q`/`ref`/`type`/`title`/`body` and anywhere in `metadata` as `invalid_input`, before any SQL. |
| **The index silently drifts from the data** | `search_vector` is a STORED generated column recomputed on every write; it cannot be set directly and cannot fall out of sync. |
| **XSS via search results** | `snippet` highlights with `<mark>` but is NOT HTML-escaped (it contains raw document text); the part documents that the consuming app must escape it before rendering as HTML (seams.md §5). |
| **Unbounded result sets / expensive scans (DoS)** | `limit` is capped at 100 and validated; the GIN index serves the `@@` match. `ts_headline` runs only on the page rows **and** over a `left(…, 8192)` slice, so per-row snippet cost is O(const) regardless of the ~1 MB body cap — closing a resource-exhaustion vector where large/phrase-matched bodies cost seconds of CPU per request. `offset` is capped at 10 000: a deeper offset forces Postgres to rank-sort (spilling to disk) the entire match set before discarding skipped rows; past a few pages, keyset pagination is the right tool. |
| **Raw driver error leakage** | Storage failures surface as `SearchError("storage")` with a generic message; the raw driver error is on `.cause`, never in `.message`. |

### Out of scope (v1, see RFC 0007 §5)

Configurable / per-document language, trigram fuzzy matching (`pg_trgm`),
faceting, and a dedicated-engine second provider are additive futures. v1 fixes
the language at `english`.
