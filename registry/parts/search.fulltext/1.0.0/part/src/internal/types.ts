/**
 * The driver-free database seam — the same minimal `node-postgres` Client/Pool
 * shape `partkit migrate` uses. The app wires its own `pg` Pool to this; the
 * part imports no driver (contract invariant 6). Wiring example: seams.md §2.
 */
export interface SqlExecutor {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A document to index (upsert by ref). */
export interface IndexDocInput {
  /** The app's document id — opaque, the upsert key. */
  ref: string;
  /** A bucket for filtering, e.g. "listing", "post". */
  type?: string;
  /** Weighted higher than body in ranking. */
  title?: string;
  /** The main searchable text. */
  body: string;
  /** Returned verbatim with results; NOT searched. */
  metadata?: Record<string, unknown>;
}

/** A search request over a RAW user query string. */
export interface SearchQuery {
  /** Raw user input — quotes, OR, -negation handled safely (never throws). */
  q: string;
  /** Restrict to one type. */
  type?: string;
  /** 1..100, default 20. */
  limit?: number;
  /** For pagination; >= 0, default 0. */
  offset?: number;
}

export interface SearchResult {
  ref: string;
  type: string | null;
  title: string | null;
  /** Relevance score (higher = better). */
  rank: number;
  /** Highlighted excerpt around the match (NOT HTML-escaped — escape before render). */
  snippet: string;
  metadata: Record<string, unknown>;
}

export interface SearchIndex {
  index(doc: IndexDocInput): Promise<void>;
  remove(ref: string): Promise<void>;
  query(input: SearchQuery): Promise<SearchResult[]>;
}
