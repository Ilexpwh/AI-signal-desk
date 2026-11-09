-- The material's 64-bit SimHash (editorial/copies.ts), written with its analysis: a later reprint from
-- another source is found by it and takes that judgement without model calls. Old rows have none.
ALTER TABLE articles ADD COLUMN simhash bigint;
