-- What an emailed code is for: 'signin' (links and sign-in codes) or 'delete' (confirms deleting the account).
-- A code is only ever accepted for its own purpose.
ALTER TABLE magic_links ADD COLUMN purpose TEXT NOT NULL DEFAULT 'signin';
-- Set once a deletion code was accepted: a retry with the same access token finishes the job without a new code.
ALTER TABLE users ADD COLUMN deleting_at INTEGER;
