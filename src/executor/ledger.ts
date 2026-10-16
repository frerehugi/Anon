import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { LedgerEntry } from "./engine.js";

/** Append-only store. Entries are never changed; a status change is a new entry with the same request id. */
export interface LedgerStore {
  all(): Promise<LedgerEntry[]>;
  append(e: LedgerEntry): Promise<void>;
}

export class MemoryLedger implements LedgerStore {
  readonly entries: LedgerEntry[] = [];
  async all() { return [...this.entries]; }
  async append(e: LedgerEntry) { this.entries.push(e); }
}

const enc = (e: LedgerEntry) => JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
const dec = (line: string): LedgerEntry => JSON.parse(line, (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

/** One JSON object per line (loop/ledger/payments.jsonl). A corrupt line is an error: spend history must be complete. */
export class JsonlLedger implements LedgerStore {
  constructor(private readonly path: string) {}
  async all() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((l, i) => {
      try { return dec(l); } catch { throw new Error(`${this.path}:${i + 1}: corrupt ledger line`); }
    });
  }
  async append(e: LedgerEntry) { appendFileSync(this.path, enc(e) + "\n", { flag: "a" }); }
}
