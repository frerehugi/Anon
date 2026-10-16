// CIO approvals: machine-readable JSON next to the human memo in loop/decisions/. The executor pays only what an approval covers.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toAtomic } from "./policy.js";

export interface Approval {
  id: string;
  memo: string;
  experiment: string;
  cap: bigint; // most this approval may spend in total
  expires: number; // unix seconds
  approvedBy: "cio";
}

export function parseApproval(text: string): Approval {
  const o = JSON.parse(text) as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof o[k] !== "string" || !(o[k] as string).trim()) throw new Error(`approval.${k} is missing`);
    return (o[k] as string).trim();
  };
  if (o.approvedBy !== "cio") throw new Error('approval.approvedBy must be "cio"');
  const expires = Date.parse(str("expires"));
  if (!Number.isFinite(expires)) throw new Error("approval.expires is not a date");
  return { id: str("id"), memo: str("memo"), experiment: str("experiment"), cap: toAtomic(o.cap, "approval.cap"), expires: Math.floor(expires / 1000), approvedBy: "cio" };
}

/** Reads every *.json in the directory. A broken file is an error, never silently skipped (fail closed on duplicates too). */
export function loadApprovals(dir: string): Approval[] {
  const out: Approval[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "gates.json").sort()) {
    try {
      out.push(parseApproval(readFileSync(join(dir, f), "utf8")));
    } catch (e) {
      throw new Error(`${f}: ${(e as Error).message}`);
    }
  }
  const ids = new Set<string>();
  for (const a of out) {
    if (ids.has(a.id)) throw new Error(`duplicate approval id ${a.id}`);
    ids.add(a.id);
  }
  return out;
}
