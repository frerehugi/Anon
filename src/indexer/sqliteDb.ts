// Local adapter on node:sqlite (tests, CLI). Never imported by the Worker.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Db, Stmt } from "./db.js";

export class SqliteDb implements Db {
  readonly raw: DatabaseSync;

  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
  }

  /** Applies each migration file once (tracked in _migrations), like wrangler does for D1. */
  migrate(dir = "migrations"): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");
    const done = new Set((this.raw.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      this.raw.exec(readFileSync(join(dir, f), "utf8"));
      this.raw.prepare("INSERT INTO _migrations (name) VALUES (?)").run(f);
    }
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }

  async batch(stmts: Stmt[]): Promise<void> {
    if (stmts.length === 0) return;
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      for (const s of stmts) this.raw.prepare(s.sql).run(...((s.params ?? []) as never[]));
      this.raw.exec("COMMIT");
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void { this.raw.close(); }
}
