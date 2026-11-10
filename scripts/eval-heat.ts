// Replays the hot list over stored evidence to choose HEAT_BUCKET_ALPHA (events/hot.ts). At sampled
// hours over the last --days it ranks the stories as heat-v1 did (every participant in full, the change
// in a story's own heat) and as heat-v2 does at each of --alphas (within a platform's bucket the k-th
// account adds decay × 1/(1 + α(k − 1)), the change in the story's share of all heat). Per α it reports
// how many stories enter and leave the top 10 against v1, the rank correlation (Spearman) over the two
// top 10s, how many trends shown would differ, and the stories most often moved in and out.
//   node --env-file=.env scripts/eval-heat.ts [--days 30] [--every 6] [--alphas 0,0.25,0.5,1] [--concurrency 4] [--out-dir .data/eval]
// Reads only, nothing is written to the database: each hour is computed from the evidence as it stands
// now, as the hourly repair does, so a report withdrawn since no longer counts. The report is written
// to --out-dir as JSON.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { behindSources, heatChange, heatRows, rankable, sourceClocks, trendOf, type HeatRow } from "@aihot/backend/events/hot";
import { evidenceCondition, listedCondition } from "@aihot/backend/publication/scope";
import { pmap, positiveInt, round } from "./eval-tools.ts";

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "30" },
    every: { type: "string", default: "6" },
    alphas: { type: "string", default: "0,0.25,0.5,1" },
    concurrency: { type: "string", default: "4" },
    "out-dir": { type: "string", default: ".data/eval" },
  },
});

const TOP = 10;
const H = 3600_000;

/** Spearman's rho of two orderings over the stories either puts in its top 10, re-ranked within them. */
function spearman(a: number[], b: number[]): number | null {
  const union = [...new Set([...a.slice(0, TOP), ...b.slice(0, TOP)])];
  const n = union.length;
  if (n < 2) return null;
  const within = (order: number[]) => new Map(order.filter((id) => union.includes(id)).map((id, i) => [id, i]));
  const [ra, rb] = [within(a), within(b)];
  const d2 = union.reduce((sum, id) => sum + (ra.get(id)! - rb.get(id)!) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

/** v1's change: the story's own heat against six hours before, over the same comparable participants. */
const v1Change = (r: HeatRow) => (Number(r.heat_prev_obs) > 0 ? Number(r.heat_obs) / Number(r.heat_prev_obs) - 1 : null);

interface Sample {
  at: string;
  candidates: number;
  perAlpha: Record<string, { entered: number[]; left: number[]; rho: number | null; trendsChanged: number; compared: number }>;
}

async function main() {
  const days = positiveInt(values.days!, "days");
  const every = positiveInt(values.every!, "every");
  const concurrency = positiveInt(values.concurrency!, "concurrency");
  const alphas = [...new Set(values.alphas!.split(",").map((value) => Number(value.trim())))];
  if (!alphas.length || alphas.some((alpha) => !Number.isFinite(alpha) || alpha < 0)) throw new Error("--alphas must be comma-separated numbers of at least 0");

  const clocks = await sourceClocks();
  const latest = Math.floor(Date.now() / H) * H;
  const hours = Array.from({ length: Math.floor((days * 24) / every) }, (_, i) => new Date(latest - i * every * H)).reverse();
  console.log(`replaying ${hours.length} hour(s) over ${days} day(s), every ${every} h, α ∈ {${alphas.join(", ")}}`);

  const titles = new Map<number, string>();
  const samples = await pmap(hours, concurrency, async (at): Promise<Sample> => {
    const behind = behindSources(clocks, at.getTime(), false);
    const v1 = rankable(await heatRows(at, behind, { alpha: 0 }));
    // Only stories with a report listed at that hour can be shown; that does not depend on α.
    const ids = v1.map((r) => Number(r.story_id));
    const listed = new Set(ids.length ? (await sql<{ story_id: number }[]>`
      SELECT DISTINCT f.story_id FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      WHERE f.story_id = ANY(${ids}::bigint[]) AND ${evidenceCondition()} AND ${listedCondition(at)}`).map((r) => Number(r.story_id)) : []);
    const shown = (rows: HeatRow[]) => rows.filter((r) => listed.has(Number(r.story_id)));
    const base = shown(v1);
    for (const r of base.slice(0, TOP)) titles.set(Number(r.story_id), r.title);
    const baseOrder = base.map((r) => Number(r.story_id));
    const baseTop = new Set(baseOrder.slice(0, TOP));
    const v1Trend = new Map(base.map((r) => [Number(r.story_id), trendOf(r, v1Change(r))]));
    const perAlpha: Sample["perAlpha"] = {};
    for (const alpha of alphas) {
      const rows = shown(alpha === 0 ? v1 : rankable(await heatRows(at, behind, { alpha })));
      for (const r of rows.slice(0, TOP)) titles.set(Number(r.story_id), r.title);
      const order = rows.map((r) => Number(r.story_id));
      const top = rows.slice(0, TOP);
      const topIds = new Set(order.slice(0, TOP));
      perAlpha[alpha] = {
        entered: [...topIds].filter((id) => !baseTop.has(id)),
        left: [...baseTop].filter((id) => !topIds.has(id)),
        rho: spearman(baseOrder, order),
        trendsChanged: top.filter((r) => trendOf(r, heatChange(r)) !== v1Trend.get(Number(r.story_id))).length,
        compared: top.length,
      };
    }
    return { at: at.toISOString(), candidates: base.length, perAlpha };
  });

  const summary = alphas.map((alpha) => {
    const runs = samples.map((s) => s.perAlpha[alpha]!);
    const rhos = runs.map((r) => r.rho).filter((rho): rho is number => rho !== null);
    const moved = (key: "entered" | "left") => {
      const counts = new Map<number, number>();
      for (const r of runs) for (const id of r[key]) counts.set(id, (counts.get(id) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10).map(([storyId, times]) => ({ storyId, times, title: titles.get(storyId) ?? "" }));
    };
    const compared = runs.reduce((sum, r) => sum + r.compared, 0);
    return {
      alpha,
      samples: runs.length,
      meanEntered: round(runs.reduce((sum, r) => sum + r.entered.length, 0) / Math.max(1, runs.length)),
      maxEntered: Math.max(0, ...runs.map((r) => r.entered.length)),
      meanRho: rhos.length ? round(rhos.reduce((sum, rho) => sum + rho, 0) / rhos.length) : null,
      minRho: rhos.length ? round(Math.min(...rhos)) : null,
      trendsChanged: runs.reduce((sum, r) => sum + r.trendsChanged, 0),
      trendsCompared: compared,
      mostEntered: moved("entered"),
      mostLeft: moved("left"),
    };
  });
  for (const s of summary) {
    console.log(`α=${s.alpha}  top ${TOP}: ${s.meanEntered} in / out per hour (at most ${s.maxEntered})  rho mean ${s.meanRho ?? "—"} min ${s.minRho ?? "—"}  trends changed ${s.trendsChanged}/${s.trendsCompared}`);
    for (const m of s.mostEntered.slice(0, 3)) console.log(`    in  ×${m.times}  ${m.title}`);
    for (const m of s.mostLeft.slice(0, 3)) console.log(`    out ×${m.times}  ${m.title}`);
  }
  const outDir = path.resolve(REPO_ROOT, values["out-dir"]!);
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `heat-${days}d-${every}h-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ meta: { days, every, alphas, top: TOP, createdAt: new Date().toISOString() }, summary, samples }, null, 2));
  console.log(`report: ${file}`);
}

try {
  await main();
} finally {
  await closeDb();
}
