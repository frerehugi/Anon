export interface IndexerEnv {
  SIGNERS?: string; // comma separated facilitator signer addresses
  LABELS?: string; // JSON: { "<payTo address>": "label" }
  MAX_STATEMENTS?: string;
  MAX_WINDOWS?: string;
  WINDOW_BLOCKS?: string;
  BACKFILL_DAYS?: string;
  SQD_BASE_URL?: string;
}

/** Celo facilitator signer (from /supported) and the third-party x402Go signer, watched for market share. */
export const DEFAULT_SIGNERS = [
  "0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48",
  "0x402001b3fbf1462939657eb7f64ee3743eadf35e",
];

/** Public payTo of the buy gateway (gateway.usebuy.ai/v1/catalog, payment.payTo): gives the per-shop slice. */
export const DEFAULT_LABELS: Record<string, string> = { "0x20faaca5f980e29639a0fcc6dca6988e18ed333b": "buy gateway" };

const int = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };

export function parseConfig(env: IndexerEnv) {
  const signers = (env.SIGNERS ? env.SIGNERS.split(",") : DEFAULT_SIGNERS).map((s) => s.trim().toLowerCase()).filter(Boolean);
  let labels: Record<string, string> = { ...DEFAULT_LABELS };
  if (env.LABELS) {
    try { labels = JSON.parse(env.LABELS); } catch { labels = {}; }
  }
  return {
    signers, labels,
    maxStatements: int(env.MAX_STATEMENTS, 40),
    maxWindows: int(env.MAX_WINDOWS, 8),
    windowBlocks: int(env.WINDOW_BLOCKS, 2500),
    backfillBlocks: int(env.BACKFILL_DAYS, 4) * 86400,
    sqdBase: env.SQD_BASE_URL,
  };
}
