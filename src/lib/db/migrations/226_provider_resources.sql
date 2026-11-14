-- Native provider resources retain their upstream ids and connection owner.
-- No file contents, prompts, or provider credentials belong in this registry.
CREATE TABLE IF NOT EXISTS provider_resources (
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'gemini')),
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'cache')),
  resource_id TEXT NOT NULL,
  api_key_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, connection_id, kind, resource_id)
);
