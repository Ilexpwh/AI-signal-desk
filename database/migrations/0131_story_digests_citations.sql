-- The digest sentence by sentence with the reports each one cites (events/digest.ts): [{text, reports,
-- newParagraph}]. The digest column stays their joined text for every reader; versions written before
-- citations have none until the story's digest is written again.
ALTER TABLE story_digests ADD COLUMN citations jsonb;
