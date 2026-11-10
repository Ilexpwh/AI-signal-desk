// Thirty days of what each source brought, for the admin source list and the weekly report: evidence the
// owner sets tiers by. Nothing here changes a tier.
import { sql } from "../db.ts";
import { ownFactEvidenceCondition } from "../publication/scope.ts";

export const SOURCE_STATS_DAYS = 30;

export interface SourceStats {
  id: string;
  name: string;
  tier: string;
  enabled: boolean;
  /** Articles it brought in. */
  items: number;
  /** Of those, selected and not withdrawn. */
  selected: number;
  /** Facts it reported that another source reported too (counted over all their reports, not only the window's). */
  shared: number;
  /** Of those, the facts its report was the first of, by publication time. */
  first: number;
}

/** Every source's, or the given ones', reports discovered in the SOURCE_STATS_DAYS before `now`. */
export async function sourceStats(now = Date.now(), ids?: string[]): Promise<SourceStats[]> {
  const since = new Date(now - SOURCE_STATS_DAYS * 86400_000);
  const only = (column: ReturnType<typeof sql>) => (ids ? sql`AND ${column} = ANY(${ids}::text[])` : sql``);
  return sql<SourceStats[]>`
    WITH reports AS (
      -- Each public report under its own fact, while it is still evidence of it.
      SELECT a.source_id, p.fact_id FROM articles a JOIN publications p ON p.article_id = a.id
      WHERE a.discovered_at > ${since} ${only(sql`a.source_id`)}
        AND p.fact_id IS NOT NULL AND p.visibility <> 'withdrawn' AND ${ownFactEvidenceCondition()}
    ), facts AS (
      SELECT f.fact_id, m.first_source, m.sources
      FROM (SELECT DISTINCT fact_id FROM reports) f CROSS JOIN LATERAL (
        SELECT (array_agg(p.source_id ORDER BY coalesce(p.published_at, p.discovered_at), p.article_id))[1] AS first_source,
          count(DISTINCT p.source_id) AS sources
        FROM publications p WHERE p.fact_id = f.fact_id AND p.visibility <> 'withdrawn' AND ${ownFactEvidenceCondition()}
      ) m
    ), reach AS (
      SELECT r.source_id, count(DISTINCT r.fact_id) FILTER (WHERE f.sources > 1)::int AS shared,
        count(DISTINCT r.fact_id) FILTER (WHERE f.sources > 1 AND f.first_source = r.source_id)::int AS first
      FROM reports r JOIN facts f USING (fact_id) GROUP BY r.source_id
    ), items AS (
      SELECT source_id, count(*)::int AS n FROM articles WHERE discovered_at > ${since} ${only(sql`source_id`)} GROUP BY source_id
    ), picked AS (
      SELECT source_id, count(*)::int AS n FROM publications
      WHERE selected AND visibility <> 'withdrawn' AND discovered_at > ${since} ${only(sql`source_id`)} GROUP BY source_id
    )
    SELECT s.id, s.name, s.tier, s.enabled, coalesce(i.n, 0) AS items, coalesce(k.n, 0) AS selected,
      coalesce(r.shared, 0) AS shared, coalesce(r.first, 0) AS first
    FROM sources s LEFT JOIN items i ON i.source_id = s.id LEFT JOIN picked k ON k.source_id = s.id LEFT JOIN reach r ON r.source_id = s.id
    WHERE true ${only(sql`s.id`)}
    ORDER BY s.name, s.id`;
}
