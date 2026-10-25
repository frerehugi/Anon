-- On-chain facts per agent, read through a paid RPC (see executor `enrich`). Raw values: reputation can be padded by anyone.
CREATE TABLE IF NOT EXISTS agent_chain (
  agent_id INTEGER PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  checked_block INTEGER,
  owner_now TEXT,
  agent_wallet TEXT,
  rep_clients INTEGER,
  rep_count INTEGER,
  rep_value TEXT,      -- int128 as decimal string
  rep_decimals INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_chain_checked ON agent_chain (checked_at);
