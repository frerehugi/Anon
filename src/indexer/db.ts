/**
 * Minimal database interface so the same indexer runs on Cloudflare D1 (production) and on a local
 * SQLite file (tests and CLI). No @cloudflare/workers-types: only the small subset used here is declared.
 */
export interface Stmt { sql: string; params?: unknown[] }

export interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** All statements run in one transaction (D1 batch semantics): everything or nothing. */
  batch(stmts: Stmt[]): Promise<void>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

export class D1Db implements Db {
  constructor(private readonly d1: D1DatabaseLike) {}

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.d1.prepare(sql).bind(...params).all<T>();
    return r.results ?? [];
  }

  async batch(stmts: Stmt[]): Promise<void> {
    if (stmts.length === 0) return;
    await this.d1.batch(stmts.map((s) => this.d1.prepare(s.sql).bind(...(s.params ?? []))));
  }
}
