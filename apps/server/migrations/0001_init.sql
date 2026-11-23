-- Accounts
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  apple_sub TEXT UNIQUE,
  google_sub TEXT UNIQUE,
  name TEXT,
  created_at INTEGER NOT NULL
);

-- One row per signed-in device. The refresh token is stored only as a hash and rotates on every refresh.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  return_to TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Ownership of notebook docs (nb: and pg:). Claimed by the first user who asks for a sync ticket.
CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  ai_access INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX notebooks_owner ON notebooks(owner_id);

-- Single-use, 30 s. Stored as a hash.
CREATE TABLE sync_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- What an MCP client may see. Tokens themselves live in OAUTH_KV (@cloudflare/workers-oauth-provider).
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notebook_ids TEXT NOT NULL DEFAULT '[]',
  folder_ids TEXT NOT NULL DEFAULT '[]',
  can_comment INTEGER NOT NULL DEFAULT 0,
  can_transcribe INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  last_session TEXT
);
CREATE INDEX grants_user ON grants(user_id);

-- Connection requests shown in Settings → AI access ("Cursor wants to connect").
CREATE TABLE auth_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE INDEX auth_requests_user ON auth_requests(user_id, status);

-- Activity log: tool, target, approximate tokens.
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  tool TEXT NOT NULL,
  target TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX activity_user ON activity(user_id, at);
