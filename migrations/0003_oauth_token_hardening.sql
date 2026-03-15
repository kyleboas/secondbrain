ALTER TABLE oauth_tokens ADD COLUMN secret_fingerprint TEXT;
ALTER TABLE oauth_tokens ADD COLUMN expires_at TEXT;
