-- Lecture mode (docs/lecture-mode.md §4): cloud transcription usage, for the per-minute rate limit and the monthly
-- minutes cap. Session data itself lives in lec: rooms (doc_sizes) and R2 assets (user_assets).
CREATE TABLE transcribe_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  ms INTEGER NOT NULL
);
CREATE INDEX transcribe_usage_user_at ON transcribe_usage(user_id, at);
