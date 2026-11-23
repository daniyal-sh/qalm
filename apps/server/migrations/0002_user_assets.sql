-- Which user uploaded which content-addressed asset. Used for read access and the per-user storage cap.
CREATE TABLE user_assets (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, sha256)
);
