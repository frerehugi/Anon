-- Directory: ERC-8004 agents on Celo, their declared endpoints and probe results.

ALTER TABLE runs ADD COLUMN source TEXT;

CREATE TABLE IF NOT EXISTS agents (
  agent_id          INTEGER PRIMARY KEY,
  owner             TEXT    NOT NULL,
  reg_block         INTEGER,
  reg_ts            INTEGER,
  uri_kind          TEXT,                 -- data | https | ipfs | other
  uri_hash          TEXT,                 -- fingerprint of the URI, to detect changes without storing it
  pending_uri       TEXT,                 -- https/ipfs URI waiting to be fetched
  fetch_attempts    INTEGER NOT NULL DEFAULT 0,
  next_fetch_at     INTEGER,
  reg_status        TEXT    NOT NULL,     -- ok | pending | unreadable
  reg_error         TEXT,
  name              TEXT,
  description       TEXT,
  image             TEXT,
  x402_support      INTEGER,              -- 1 / 0 / NULL (not declared)
  active            INTEGER,              -- 1 / 0 / NULL (not declared)
  coherent          INTEGER,              -- registration points back at this id and the Celo registry
  services_json     TEXT,                 -- [{name,endpoint,version}]
  trust_json        TEXT,                 -- supportedTrust
  tags_json         TEXT,
  first_seen_at     INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  uri_updates       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (reg_status, next_fetch_at);
CREATE INDEX IF NOT EXISTS idx_agents_x402   ON agents (x402_support);
CREATE INDEX IF NOT EXISTS idx_agents_owner  ON agents (owner);

CREATE TABLE IF NOT EXISTS endpoints (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id              INTEGER NOT NULL,
  url                   TEXT    NOT NULL,
  declared_x402         INTEGER NOT NULL DEFAULT 0,
  next_probe_at         INTEGER,
  last_probe_at         INTEGER,
  last_status           INTEGER,
  last_pass             INTEGER,
  last_error_codes      TEXT,             -- JSON array of lint codes
  pay_to                TEXT,             -- JSON array of payTo addresses seen in the 402 challenge
  assets                TEXT,             -- JSON array of token symbols offered
  probes_total          INTEGER NOT NULL DEFAULT 0,
  probes_pass           INTEGER NOT NULL DEFAULT 0,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (agent_id, url)
);
CREATE INDEX IF NOT EXISTS idx_endpoints_due ON endpoints (next_probe_at);
