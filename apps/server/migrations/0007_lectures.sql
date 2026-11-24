-- Lecture mode (docs/lecture-mode.md §4-5).
-- Cloud transcription usage, for the per-minute rate limit and the monthly minutes cap.
CREATE TABLE transcribe_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  ms INTEGER NOT NULL
);
CREATE INDEX transcribe_usage_user_at ON transcribe_usage(user_id, at);

-- Which assets (audio chunks, crop PNGs; content-addressed in R2 and user_assets) each session doc references, so
-- deleting a session frees only what no other session of the user still uses.
CREATE TABLE lecture_assets (
  doc_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (doc_id, sha256)
);
CREATE INDEX lecture_assets_user_sha ON lecture_assets(user_id, sha256);

-- Deleted sessions: no sync tickets for them again, so another device can't recreate one by syncing its copy.
CREATE TABLE deleted_lectures (
  doc_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX deleted_lectures_user ON deleted_lectures(user_id);
