// Topic trends: for each topic (industry/topics.json) and Beijing day, the stories an editorial
// participant reported about it that day, as a share of all such stories, against its mean share over
// the 28 days before. A report counts for the topics it belongs to (publication/topics.ts), from the
// heat evidence as it stands (currentSignals): a withdrawn report or a changed source role reaches the
// trends at the next run. What counts as breaking out is read with the rows (TOPIC_RISING), not stored.
import { addDays, beijingDate, beijingMidnight, BEIJING_TIMEZONE } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { storyReportCondition } from "../publication/scope.ts";
import { topicMembership } from "../publication/topics.ts";
import { currentSignals } from "./hot.ts";

/** A day's share is compared with its mean over this many days before it. */
const BASELINE_DAYS = 28;
/** Days written again on every run: evidence carries its source's time and is grouped after collection, so a day can still change once it is over; a missed run is filled too. */
const REWRITTEN_DAYS = 7;

interface TrendRow {
  topic: string;
  day: string;
  stories: number;
  baseline: number | null;
  ratio: number | null;
}

/**
 * The topics.trend timer: the last REWRITTEN_DAYS complete Beijing days before `at`, each topic with a
 * story that day. The mean runs over the days before that had any story, so a stop in collection does
 * not lower it and a new site compares with the days it has; with none there is no baseline, and a
 * topic absent from all of them has no ratio.
 */
export async function computeTopicTrends(at = new Date()): Promise<{ days: number; rows: number }> {
  const today = beijingDate(at);
  const first = addDays(today, -REWRITTEN_DAYS);
  const counts = await sql<{ day: string; topic: string | null; stories: number }[]>`
    WITH reported AS (
      SELECT DISTINCT (cs.observed_at AT TIME ZONE ${BEIJING_TIMEZONE})::date AS day, cs.story_id, ${topicMembership()} AS topics
      FROM ${currentSignals()} cs JOIN publications p ON p.article_id = cs.article_id JOIN sources s ON s.id = p.source_id
      WHERE cs.kind = 'editorial' AND ${storyReportCondition(at)}
        AND cs.observed_at >= ${beijingMidnight(addDays(first, -BASELINE_DAYS))} AND cs.observed_at < ${beijingMidnight(today)}
    )
    SELECT day::text AS day, NULL AS topic, count(DISTINCT story_id)::int AS stories FROM reported GROUP BY day
    UNION ALL
    SELECT day::text, t.topic, count(DISTINCT story_id)::int FROM reported CROSS JOIN LATERAL unnest(topics) AS t(topic) GROUP BY day, t.topic`;
  const totals = new Map<string, number>();
  const byTopic = new Map<string, Map<string, number>>();
  for (const c of counts) {
    if (c.topic === null) totals.set(c.day, c.stories);
    else byTopic.set(c.topic, (byTopic.get(c.topic) ?? new Map()).set(c.day, c.stories));
  }
  const share = (stories: Map<string, number>, day: string) => (stories.get(day) ?? 0) / totals.get(day)!;
  const rows: TrendRow[] = [];
  for (let day = first; day < today; day = addDays(day, 1)) {
    const before = [...totals.keys()].filter((d) => d < day && d >= addDays(day, -BASELINE_DAYS));
    for (const [topic, stories] of byTopic) {
      const n = stories.get(day);
      if (!n) continue;
      const baseline = before.length ? before.reduce((sum, d) => sum + share(stories, d), 0) / before.length : null;
      rows.push({ topic, day, stories: n, baseline, ratio: baseline ? share(stories, day) / baseline : null });
    }
  }
  await sql.begin(async (tx) => {
    await tx`DELETE FROM topic_trends WHERE day >= ${first}::date AND day < ${today}::date`;
    if (rows.length) await tx`INSERT INTO topic_trends ${tx(rows)}`;
  });
  return { days: REWRITTEN_DAYS, rows: rows.length };
}
