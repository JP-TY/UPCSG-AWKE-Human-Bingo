export interface D1Result<Row> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface D1DatabaseLike {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
      run(): Promise<D1Result<never>>;
    };
  };
}

export interface D1Transaction {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<D1Result<Row>>;
}

// Minimal helper for Workers: runs work with a transaction that proxies to D1.
// D1 is single-writer per database; the BingoRoom DO serializes per gameId, so
// no explicit BEGIN/COMMIT is needed. We keep the same try/catch shape as
// withTransaction so callers can share error handling.
export async function withD1Transaction<T>(
  db: D1DatabaseLike,
  work: (tx: D1Transaction) => Promise<T>,
): Promise<T> {
  const tx: D1Transaction = {
    query: async <Row>(text: string, values?: readonly unknown[]) => {
      const stmt = db.prepare(text).bind(...(values ?? []));
      const upper = text.trimStart().toUpperCase();
      const hasReturning = /\bRETURNING\b/i.test(text);
      if (upper.startsWith('SELECT') || hasReturning) {
        const res = await stmt.all<Row>();
        return { rows: res.rows, rowCount: res.rows.length } as D1Result<Row>;
      }
      await stmt.run();
      return { rows: [], rowCount: 0 } as unknown as D1Result<Row>;
    },
  };
  return work(tx);
}
