-- Anon Index schema. SQLite dialect, applied to Cloudflare D1 with `wrangler d1 migrations apply`.

-- One row per EIP-3009 settlement of a tracked stablecoin, sent by a known facilitator signer.
CREATE TABLE IF NOT EXISTS settlements (
  tx_hash        TEXT    NOT NULL,
  log_index      INTEGER NOT NULL,
  block          INTEGER NOT NULL,
  ts             INTEGER NOT NULL,
  token          TEXT    NOT NULL,
  payer          TEXT    NOT NULL,
  pay_to         TEXT    NOT NULL,
  amount_atomic  TEXT    NOT NULL,
  usd            REAL    NOT NULL,
  relayer        TEXT    NOT NULL,
  gas_used       INTEGER,
  gas_price_wei  INTEGER,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_settlements_ts     ON settlements (ts);
CREATE INDEX IF NOT EXISTS idx_settlements_pay_to ON settlements (pay_to, ts);

-- Signer transactions without a tracked-token transfer (other assets, approvals, failures).
-- Kept so that coverage is measurable instead of silently dropped.
CREATE TABLE IF NOT EXISTS unclassified_txs (
  tx_hash        TEXT PRIMARY KEY,
  block          INTEGER NOT NULL,
  ts             INTEGER NOT NULL,
  relayer        TEXT    NOT NULL,
  to_address     TEXT,
  gas_used       INTEGER,
  gas_price_wei  INTEGER,
  status         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_unclassified_ts ON unclassified_txs (ts);

-- Last fully processed block per source. Advanced in the same transaction as the rows it covers.
CREATE TABLE IF NOT EXISTS cursor (
  source      TEXT PRIMARY KEY,
  last_block  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One row per indexer cycle, for observability.
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  from_block    INTEGER,
  to_block      INTEGER,
  windows       INTEGER NOT NULL DEFAULT 0,
  settlements   INTEGER NOT NULL DEFAULT 0,
  unclassified  INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL,
  error         TEXT
);
