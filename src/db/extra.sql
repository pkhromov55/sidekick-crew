-- Full-text search over the event log (simple config works for Russian + English tokens).
CREATE INDEX IF NOT EXISTS messages_fts
  ON messages USING gin (to_tsvector('simple', coalesce(text, '')));
