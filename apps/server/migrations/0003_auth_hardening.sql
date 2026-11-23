-- Magic links are bound to the device that asked (hash of a nonce only that device knows) and carry a 6-digit code fallback.
ALTER TABLE magic_links ADD COLUMN nonce_hash TEXT;
ALTER TABLE magic_links ADD COLUMN code_hash TEXT;
ALTER TABLE magic_links ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX magic_links_email ON magic_links(email, expires_at);

-- The immediately-previous refresh token stays usable for a short grace window after rotation (two tabs refreshing at once).
ALTER TABLE sessions ADD COLUMN prev_hash TEXT;
ALTER TABLE sessions ADD COLUMN rotated_at INTEGER;

-- Sign-in emails sent, for rate limits (key = 'email:<address>' or 'ip:<address>'). Rows older than an hour are pruned.
CREATE TABLE email_sends (
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX email_sends_key ON email_sends(key, at);
