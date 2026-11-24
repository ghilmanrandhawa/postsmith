import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  credits       INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  created_at    INTEGER NOT NULL
);

-- Every credit movement is recorded; users.credits is the running balance.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id),
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,           -- signup | purchase | post | refund | dev_topup
  ref        TEXT,                    -- post id / stripe session id
  created_at INTEGER NOT NULL,
  UNIQUE (reason, ref)                -- makes Stripe webhook retries idempotent
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

-- OAuth 2.1: dynamically registered clients (RFC 7591). ChatGPT and Claude register themselves.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  redirect_uris TEXT NOT NULL,        -- JSON array
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope          TEXT NOT NULL,
  resource       TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

-- Access and refresh tokens are stored hashed; the raw value is only ever shown to the client.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id   TEXT NOT NULL,           -- shared by all tokens from one authorization (for revocation)
  client_id  TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  scope      TEXT NOT NULL,
  resource   TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);

CREATE TABLE IF NOT EXISTS posts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  platform     TEXT NOT NULL,
  brief        TEXT NOT NULL,
  headline     TEXT NOT NULL,
  caption      TEXT NOT NULL,
  hashtags     TEXT NOT NULL,         -- JSON array
  theme        TEXT NOT NULL,
  status       TEXT NOT NULL,         -- queued | generating | ready | failed | scheduled
  progress     INTEGER NOT NULL DEFAULT 0,
  step         TEXT NOT NULL DEFAULT '',
  error        TEXT,
  scheduled_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id, created_at);
`);

export const now = () => Math.floor(Date.now() / 1000);
