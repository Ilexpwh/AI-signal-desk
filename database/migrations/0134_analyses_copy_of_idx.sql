-- The copies that took an original's judgement, found when an editor withdraws or corrects it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS analyses_copy_of_idx ON analyses ((output->>'copyOf')) WHERE output->>'copyOf' IS NOT NULL;
