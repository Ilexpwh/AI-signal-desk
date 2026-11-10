// 未收录主体: the fact subjects the structure step named that are no company of the vocabulary
// (industry/taxonomy.ts ENTITIES), counted over the last month, for the owner to add by hand. It reads
// what each article's latest analysis kept (output.unmatchedSubjects); nothing calls a model.
import type { AdminUnmatchedSubjects, BeforeJson } from "@aihot/contracts/admin";
import { IDENTITY_LEXICON } from "@aihot/industry/taxonomy";
import { sql } from "../db.ts";
import { entityIdentity, nameKey } from "../editorial/vocabulary.ts";
import { matchEntityIds } from "../editorial/writing.ts";

export const UNMATCHED_SUBJECT_DAYS = 30;
export const UNMATCHED_SUBJECT_MIN = 3;

interface Named { name: string; count: number; last_seen_at: Date; latest_article_id: string }

/**
 * Names in at least UNMATCHED_SUBJECT_MIN articles discovered in the window, most often first. Spellings that
 * differ only in case, width or spaces count as one, under the most frequent; a name the vocabulary has learnt
 * since leaves the list at once. Each carries the identity lexicon's companies it reads in the name.
 */
export async function unmatchedSubjects(now = Date.now()): Promise<BeforeJson<AdminUnmatchedSubjects>> {
  const since = new Date(now - UNMATCHED_SUBJECT_DAYS * 86400_000);
  const rows = await sql<Named[]>`
    SELECT n.name, count(*)::int AS count, max(a.discovered_at) AS last_seen_at,
      (array_agg(a.id ORDER BY a.discovered_at DESC, a.id))[1] AS latest_article_id
    FROM articles a
    CROSS JOIN LATERAL (SELECT output FROM analyses WHERE article_id = a.id ORDER BY id DESC LIMIT 1) an
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(an.output->'unmatchedSubjects', '[]'::jsonb)) AS n(name)
    WHERE a.discovered_at > ${since}
    GROUP BY n.name
    ORDER BY count(*) DESC, n.name`;
  const merged = new Map<string, Named>();
  for (const r of rows) {
    if (entityIdentity(r.name)) continue;
    const seen = merged.get(nameKey(r.name));
    merged.set(nameKey(r.name), !seen ? r : {
      ...seen,
      count: seen.count + r.count,
      ...(r.last_seen_at > seen.last_seen_at ? { last_seen_at: r.last_seen_at, latest_article_id: r.latest_article_id } : {}),
    });
  }
  const lexiconName = (id: string) => IDENTITY_LEXICON.find((e) => e.id === id)!.name;
  return {
    days: UNMATCHED_SUBJECT_DAYS,
    min: UNMATCHED_SUBJECT_MIN,
    rows: [...merged.values()].filter((r) => r.count >= UNMATCHED_SUBJECT_MIN)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map((r) => ({ ...r, lexicon: matchEntityIds([r.name]).map(lexiconName) })),
  };
}
