CREATE TABLE IF NOT EXISTS oauth_clients (
	id TEXT PRIMARY KEY,
	redirect_uris TEXT NOT NULL,
	name TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS oauth_codes (
	code TEXT PRIMARY KEY,
	client_id TEXT NOT NULL,
	redirect_uri TEXT NOT NULL,
	code_challenge TEXT,
	code_challenge_method TEXT,
	expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
	token TEXT PRIMARY KEY,
	client_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
