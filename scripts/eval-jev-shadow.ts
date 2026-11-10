// How a decision model's shadow answers (editorial/shadow.ts, admin → 模型与评测 → 影子运行) compare with
// the model steps on the same articles, read from receipts and analyses only (no calls):
// - prefilter: Jev's label against the step's, as a confusion matrix;
// - score: Jev's median total against the mean of the step's scores, a monotone mapping between the two
//   (the `scale` to paste into industry/decisions.ts), and for each confidence floor how often Jev would
//   decide alone and how often it then lands on the same side of every line (threshold, writing floor,
//   browse floor) as the step. `oneCallDisagreement` is the same measure for one model score against the
//   mean of two: the floor to choose is one where Jev disagrees no more often than that.
// The model steps are not the gold set: run scripts/eval-selection.ts with the decision model too before
// switching anything (docs/selection.md, "试用 Jev").
// Usage: node --env-file=.env scripts/eval-jev-shadow.ts [--days 14] [--model jev]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { DECISION_STEPS, DECISION_VERSIONS, medianTotal, scaled, scoreLines, scoreSure, scoreTail } from "@aihot/backend/editorial/decisions";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { missingEvidence } from "@aihot/backend/editorial/writing";
import { MODELS } from "@aihot/backend/providers/llm";
import { readAnswers } from "@aihot/backend/providers/typesafe";
import { DECISIONS } from "@aihot/industry/decisions";
import { positiveInt, round } from "./eval-tools.ts";

const { values } = parseArgs({ options: { days: { type: "string", default: "14" }, model: { type: "string", default: "jev" } } });
const days = positiveInt(values.days!, "days");
const spec = MODELS[values.model!];
if (spec?.api !== "systemone") throw new Error(`${values.model} is not a decision model`);
const FLOORS = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99];

/** Each shadow answer of a step in the window, with the latest model analysis of the same article revision. */
const shadowRows = (step: keyof typeof DECISION_STEPS) => sql<{ receipt_id: number; response: unknown; article_id: string; revision: number; output: Record<string, any> }[]>`
  SELECT r.id AS receipt_id, r.response, an.article_id, an.input_revision AS revision, an.output
  FROM receipts r
  JOIN LATERAL (
    SELECT an.article_id, an.input_revision, an.output FROM analyses an
    WHERE an.article_id = split_part(substr(r.subject, length('article:') + 1), '@', 1)
      AND an.input_revision = split_part(r.subject, '@', 2)::int AND an.origin = 'model'
    ORDER BY an.id DESC LIMIT 1
  ) an ON true
  WHERE r.subject LIKE 'article:%@%' AND r.service = ${spec.service} AND r.model = ${spec.model} AND r.purpose = ${DECISION_STEPS[step]}
    AND r.request->>'promptVersion' = ${DECISION_VERSIONS[step]} AND r.status IN ('received', 'completed')
    AND r.created_at > now() - make_interval(days => ${days})
  ORDER BY r.id`;

// Prefilter: the step's label (after its own BLOCK-without-text rule) against Jev's, with the same rule.
const LABELS = ["PASS", "BLOCK", "UNKNOWN"] as const;
const confusion = Object.fromEntries(LABELS.map((l) => [l, Object.fromEntries(LABELS.map((j) => [j, 0]))])) as Record<string, Record<string, number>>;
const prefilterByFloor = FLOORS.map((floor) => ({ floor, alone: 0, agree: 0 }));
let prefilterRows = 0, prefilterUnreadable = 0, prefilterRevised = 0;
for (const row of await shadowRows("prefilter")) {
  const llm = row.output?.prefilter?.label as string | undefined;
  if (!llm || !(llm in confusion)) continue;
  let answer;
  try { answer = readAnswers(DECISIONS.prefilter, row.response).relevance; }
  catch { prefilterUnreadable += 1; continue; }
  let jev = answer.choice;
  if (jev === "BLOCK") {
    const input = await loadAnalyzeInput(row.article_id);
    if (!input || input.revision !== row.revision) { prefilterRevised += 1; continue; }
    if (missingEvidence(input)) jev = "UNKNOWN";
  }
  prefilterRows += 1;
  confusion[llm]![jev]! += 1;
  for (const f of prefilterByFloor) {
    if (answer.confidence < f.floor) continue;
    f.alone += 1;
    if (jev === llm) f.agree += 1;
  }
}

// Score: pairs of Jev's median total (before any scale) and the step's mean, then a monotone fit of one to the other.
interface Pair { tail: number[]; jev: number; mean: number; first: number | null; second: number | null; threshold: number }
const pairs: Pair[] = [];
let scoreUnreadable = 0;
for (const row of await shadowRows("score")) {
  const scores = Array.isArray(row.output?.scores) ? (row.output.scores as unknown[]).filter((v): v is number => typeof v === "number") : [];
  const threshold = row.output?.threshold;
  if (!scores.length || typeof threshold !== "number") continue;
  let tail;
  try { tail = scoreTail(readAnswers(DECISIONS.score, row.response)); }
  catch { scoreUnreadable += 1; continue; }
  pairs.push({ tail, jev: medianTotal(tail), mean: scores.reduce((a, b) => a + b, 0) / scores.length, first: scores[0] ?? null, second: scores[1] ?? null, threshold });
}

/** Pool-adjacent-violators: the non-decreasing fit of y on x, as [x, y] points (both ends of each pooled block). */
function isotonic(points: Array<[number, number]>): Array<[number, number]> {
  const blocks: Array<{ lo: number; hi: number; sum: number; n: number }> = [];
  for (const [x, y] of [...points].sort((a, b) => a[0] - b[0])) {
    blocks.push({ lo: x, hi: x, sum: y, n: 1 });
    while (blocks.length > 1 && blocks.at(-2)!.sum / blocks.at(-2)!.n >= blocks.at(-1)!.sum / blocks.at(-1)!.n) {
      const last = blocks.pop()!;
      const prev = blocks.at(-1)!;
      Object.assign(prev, { hi: last.hi, sum: prev.sum + last.sum, n: prev.n + last.n });
    }
  }
  const out: Array<[number, number]> = [];
  for (const b of blocks) {
    const y = Math.round((b.sum / b.n) * 10) / 10;
    out.push([b.lo, y]);
    if (b.hi !== b.lo) out.push([b.hi, y]);
  }
  return out;
}

const fitted = isotonic(pairs.map((p) => [p.jev, p.mean]));
const mae = (scale: Array<[number, number]>) => (pairs.length ? round(pairs.reduce((a, p) => a + Math.abs(scaled(p.jev, scale) - p.mean), 0) / pairs.length) : null);
const sides = (score: number, threshold: number) => scoreLines(threshold).map((line) => score >= line);
const sameSides = (a: boolean[], b: boolean[]) => a.every((v, i) => v === b[i]);
const scoreByFloor = FLOORS.map((floor) => {
  const alone = pairs.filter((p) => scoreSure(p.tail, floor, p.threshold, fitted));
  const agree = alone.filter((p) => sameSides(sides(scaled(p.jev, fitted), p.threshold), sides(p.mean, p.threshold)));
  return { floor, aloneRate: pairs.length ? round(alone.length / pairs.length) : null, disagreement: alone.length ? round(1 - agree.length / alone.length) : null, alone: alone.length };
});
// One model call against the mean of two, on the same measure: the bar Jev has to meet where it decides alone.
const twoScores = pairs.filter((p) => p.first !== null && p.second !== null);
const oneCallDisagreement = twoScores.length
  ? round(twoScores.filter((p) => !sameSides(sides(p.first!, p.threshold), sides(p.mean, p.threshold))).length / twoScores.length)
  : null;

const report = {
  meta: { model: values.model, days, versions: DECISION_VERSIONS, createdAt: new Date().toISOString() },
  prefilter: {
    n: prefilterRows, unreadable: prefilterUnreadable, revised: prefilterRevised,
    agreement: prefilterRows ? round(LABELS.reduce((a, l) => a + confusion[l]![l]!, 0) / prefilterRows) : null,
    confusion, byFloor: prefilterByFloor.map((f) => ({ floor: f.floor, aloneRate: prefilterRows ? round(f.alone / prefilterRows) : null, disagreement: f.alone ? round(1 - f.agree / f.alone) : null })),
  },
  score: {
    n: pairs.length, unreadable: scoreUnreadable,
    maeUnscaled: mae([]), maeScaled: mae(fitted), scale: fitted, oneCallDisagreement, twoScoreCases: twoScores.length, byFloor: scoreByFloor,
  },
};
console.log(`prefilter: ${report.prefilter.n} 条，一致 ${report.prefilter.agreement}（行是模型步骤，列是 ${values.model}）`);
console.table(confusion);
console.table(report.prefilter.byFloor);
console.log(`score: ${pairs.length} 条，平均差 ${report.score.maeUnscaled} → 换算后 ${report.score.maeScaled}；一次模型评分与两次平均的分歧 ${oneCallDisagreement}（${twoScores.length} 条）`);
console.table(scoreByFloor);
console.log(`scale: ${JSON.stringify(fitted)}`);
const outDir = path.join(REPO_ROOT, ".data/eval");
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `jev-shadow-${days}d-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`report: ${file}`);
await closeDb();
