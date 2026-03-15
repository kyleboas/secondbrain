CREATE TABLE IF NOT EXISTS memories (
	id TEXT PRIMARY KEY,
	namespace TEXT NOT NULL,
	content TEXT NOT NULL,
	tags TEXT NOT NULL DEFAULT '',
	source TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_namespace_created_at
ON memories(namespace, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_tags
ON memories(tags);
