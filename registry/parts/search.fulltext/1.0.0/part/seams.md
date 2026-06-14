# Seams — search.fulltext

What YOUR app provides. Reading `contract.json` + this file is enough to wire
the part — you never need to read `src/`. Never edit `src/` (attested interior;
edits void the attestation and fail CI).

## 1. The connection seam + one migration

This part owns one Postgres table, `search_documents`, reached through a
connection you hand in. Import through your alias:

```jsonc
// tsconfig.json → compilerOptions (recommended alias)
"paths": { "@parts/*": ["./parts/*/src"] }
```

```ts
import { search, SearchError } from "@parts/search.fulltext";
```

Never deep-import `src/internal/**` (lint-enforced). No env, no adapter, no
search vendor — it's pure Postgres full-text search.

## 2. The connection seam (`SqlExecutor`)

The part is **driver-free**. Wrap your `pg` Pool once (copy `examples/pg-executor.ts`):

```ts
const db: SqlExecutor = {
  query: (sql, params) => pool.query(sql, params ? [...params] : undefined),
};
const idx = search(db);
```

Run the migration before first use:

```sh
partkit migrate            # reads DATABASE_URL; creates search_documents (+ a GIN index)
```

## 3. Index documents

```ts
const idx = search(db);

// Upsert by ref — re-indexing the same ref REPLACES the document (no duplicate).
await idx.index({
  ref: listing.id,            // your document id (the upsert key)
  type: "listing",            // a bucket for filtering (optional)
  title: listing.name,        // weighted higher than body in ranking
  body: listing.description,  // the main searchable text (required)
  metadata: { price: listing.price }, // returned verbatim with results; NOT searched
});

await idx.remove(listing.id); // idempotent — removing an absent ref is a no-op
```

The search vector is a **generated column** kept in sync by Postgres — you never
maintain it. Re-index whenever the document changes.

## 4. Search

```ts
const hits = await idx.query({
  q: 'leather "office chair" -broken',  // RAW user input — operators handled safely
  type: "listing",                       // restrict to one type (optional)
  limit: 20,                             // 1..100, default 20
  offset: 0,                             // 0..10_000; deeper → use keyset pagination
});
// hits: [{ ref, type, title, rank, snippet, metadata }, …] best-first
```

- **`q` is raw user input.** Quoted `"phrases"`, `or`, and `-negation` work;
  anything else (stray `:`, `&`, unbalanced quotes, punctuation, accents) is
  handled as a search expression and **never throws**. Pass the search box value
  straight through.
- Results are **ranked by relevance** (`title` outranks `body`), filtered by
  `type`, paginated, and ordered deterministically (stable secondary sort).
- A query that matches nothing — or an empty `q` — returns `[]`.

## 5. Snippets are NOT HTML-safe — escape before rendering

`result.snippet` highlights the matched terms with `<mark>…</mark>`, but the
surrounding text is the **raw document content** and is **not** HTML-escaped
(Postgres `ts_headline` does not sanitize). If you render it as HTML, escape the
document text first (and allow only the `<mark>` tags), or render as plain text —
otherwise a malicious document body is an XSS vector in your search results.

## 6. Error handling

A malformed `q` is **never** an error (see §4). Errors are a `SearchError` with `.code`:

| code | meaning | typical HTTP |
|---|---|---|
| `invalid_input` | bad arguments — blank `ref`/`body`, a `limit` outside 1..100, an `offset` outside 0..10_000, or a NUL byte (U+0000) anywhere in the input | 400 |
| `storage` | the executor (database) failed. The raw driver error is on `.cause`; `.message` is generic. | 500 |

## 7. What you must NOT do

- Edit or import anything under `src/internal/**`.
- `SELECT`/`INSERT`/`UPDATE` `search_documents` directly, or write `search_vector`
  (it's a generated column — Postgres maintains it).
- Render `snippet` as HTML without escaping the document text (§5).
- Expect `metadata` to be searchable — it is stored and returned, not indexed.
