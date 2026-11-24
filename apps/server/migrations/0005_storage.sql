-- Stored size of each Yjs doc (snapshot + update log in its DocRoom), reported by the room a few seconds after it
-- persists. Summed per user with user_assets for the storage cap (GET /me/storage).
CREATE TABLE doc_sizes (
  doc_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX doc_sizes_user ON doc_sizes(user_id);
