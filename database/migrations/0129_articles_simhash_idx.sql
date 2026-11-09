-- The copy check compares fingerprints over the recall window's discoveries.
CREATE INDEX CONCURRENTLY IF NOT EXISTS articles_simhash_idx ON articles (discovered_at, simhash) WHERE simhash IS NOT NULL;
