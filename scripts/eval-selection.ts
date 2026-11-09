// Checks the selection against your own labelled samples (a "gold set"): each case runs the site's
// selection steps (editorial/analyze.ts) — the prefilter, then the score prompt twice with every model in
// --models (each call's content type and axes weighed by industry/selection.ts, and shown as the case's reason),
// the scores deciding against the case's tier threshold (gold cases carry no source class) — and is compared with your
// decision. Both scores are always asked; each decision replays production, which skips the second score
// when the first lies far from every line (secondScoreRate, and flipsVsBoth against deciding on both).
// A threshold sweep shows what another threshold would have done. The gold file has one case
// per line as eval-selection-core.ts describes; lines starting with // are skipped.
// A decision model (Jev, a preset with `api: "systemone"`) in --models answers the score questions of
// industry/decisions.ts instead, its median total the case's one score; `--prefilter jev` asks it the
// prefilter question too. For it the summary adds cascadeRate (cases it is not sure enough to decide alone
// at --floor, industry/decisions.ts `confidence`) and aloneAccuracy (accuracy on the rest).
// Usage: node --env-file=.env scripts/eval-selection.ts [--gold .data/gold.jsonl] [--models default,deepseek-flash] [--n 200] [--split all] [--label "..."]
//        [--prefilter jev] [--floor 0.9]
// Receipts make re-runs free; "either" cases are excluded from decisive metrics. Each run is also
// imported into SelectBench (admin → SelectBench) with every case, unless --no-import is given.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEPLOYMENT } from "@aihot/site";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import {
  SELECTION_PROMPT_VERSION,
  awaitsMaterial,
  buildScoreInput,
  decidingScores,
  runSelectionPrefilter,
  runSelectionScores,
  scoresSelect,
  selectionThreshold,
  shownScore,
  type AnalysisRun,
  type AnalyzeInputArticle,
} from "@aihot/backend/editorial/analyze";
import { importSelectBenchRun } from "@aihot/backend/admin/selectbench";
import { atLeast, decidePrefilter, decideScore, decidesAlone, type PrefilterDecision, type ScoreDecision } from "@aihot/backend/editorial/decisions";
import { failedReceiptId } from "@aihot/backend/providers/receipts";
import { isDecisionModel } from "@aihot/backend/providers/typesafe";
import { DECISIONS } from "@aihot/industry/decisions";
import { evalModels, pmap, positiveInt, safeReportNamePart, sampleCases, usageFor } from "./eval-tools.ts";
import { parseSelectionGoldJsonl, selectionMetrics, selectionThresholdMetrics, type SelectionDecision, type SelectionGoldRow } from "./eval-selection-core.ts";

// Without options: the site's gold set (site.ts DEPLOYMENT.selectionGold), else the whole of .data/gold.jsonl
// (up to 200 cases), swept over a wide range of thresholds.
const own = DEPLOYMENT.selectionGold;
const defaults = own
  ? { gold: own.file, n: String(own.sample), split: own.split, sweep: own.sweep }
  : { gold: ".data/gold.jsonl", n: "200", split: "all", sweep: [40, 90] };

const { values } = parseArgs({
  options: {
    gold: { type: "string", default: defaults.gold },
    models: { type: "string" },
    n: { type: "string", default: defaults.n },
    split: { type: "string", default: defaults.split },
    concurrency: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    label: { type: "string" },
    prefilter: { type: "string" },
    floor: { type: "string" },
    "no-import": { type: "boolean", default: false },
  },
});

const rows = parseSelectionGoldJsonl(readFileSync(path.resolve(REPO_ROOT, values.gold!), "utf8"));
const sample = sampleCases(rows, { split: values.split!, n: positiveInt(values.n!, "n"), seed: Number(values.seed) });
const concurrency = positiveInt(values.concurrency!, "concurrency");
const prefilterModel = values.prefilter ?? null;
if (prefilterModel !== null && !isDecisionModel(prefilterModel)) throw new Error(`--prefilter ${prefilterModel} is not a decision model`);
const floors = {
  prefilter: values.floor ? Number(values.floor) : DECISIONS.confidence.prefilter ?? 0.9,
  score: values.floor ? Number(values.floor) : DECISIONS.confidence.score ?? 0.9,
};
if (!(floors.score > 0.5 && floors.score <= 1)) throw new Error("--floor must be above 0.5 and at most 1");

function toInput(r: SelectionGoldRow): AnalyzeInputArticle {
  const m = r.material;
  const isX = r.sourceFacts.sourceKind === "x_search";
  const body = m.bodyOriginal || m.bodyZh || null;
  return {
    id: `gold-${r.caseId}`,
    revision: 1,
    bodyStatus: "ok",
    title: m.originalTitle || m.title,
    url: "https://example.invalid/" + r.caseId,
    author: null,
    publishedAt: m.publishedAt ? new Date(m.publishedAt) : null,
    bodyText: isX ? null : body,
    excerpt: null,
    xPost: isX ? { authorName: m.sourceName, handle: "", text: body ?? m.title } : null,
    media: [],
    source: { id: "gold", name: m.sourceName, kind: r.sourceFacts.sourceKind, tier: r.sourceFacts.sourceTier ?? "T2", firstParty: r.sourceFacts.firstParty ?? false },
  };
}

/**
 * A case as the site's rules leave it: `relevance` is what the prefilter (or missing material) decided,
 * `scores` the two scores held against the case's tier threshold. The eval writes no reader-facing copy;
 * an item past the prefilter is taken as written up, as the site writes one for every such item.
 */
interface Outcome {
  r: SelectionGoldRow;
  relevance: "pass" | "block" | "unknown" | null;
  scores: AnalysisRun["scores"];
  receiptIds: number[];
  error: string | null;
  /** A decision model's answers: the prefilter's (with --prefilter) and the score's. */
  prefilterDecision?: PrefilterDecision;
  decision?: ScoreDecision;
}

/**
 * The site's decision for the case at its tier threshold, with the scores production would have asked
 * there (decidingScores; `both` decides with every score instead); null when the case failed.
 */
const decide = (x: Outcome, both = false): SelectionDecision | null =>
  x.error !== null ? null : x.relevance === "pass" && scoresSelect(both ? x.scores : deciding(x.scores)) ? "select" : "reject";
const deciding = (scores: AnalysisRun["scores"]) => (scores ? decidingScores(scores, scores.threshold) : null);

/** Why a case scored as it did: each call's content type and axes, shown beside the case in SelectBench. */
const axesReason = (scores: AnalysisRun["scores"]): string | null =>
  scores?.axes.length
    ? scores.axes.map((s) => `${s.itemType} sig${s.sig} nov${s.nov} cred${s.cred} reson${s.reson} act${s.act}${s.thin ? " thin" : ""}`).join(" / ")
    : null;

/** A decision model's score: its median total on the score step's scale, as the case's one score. */
async function decisionScores(input: AnalyzeInputArticle, model: string, onReceipt: (id: number) => void): Promise<{ scores: AnalysisRun["scores"]; decision: ScoreDecision }> {
  try {
    const decision = await decideScore(input, model);
    onReceipt(decision.receiptId);
    return { scores: { model, threshold: 0, values: [decision.point], axes: [], receiptIds: [decision.receiptId], reused: decision.reused }, decision };
  } catch (error) {
    const id = failedReceiptId(error);
    if (id !== null) onReceipt(id);
    throw error;
  }
}

const jevReason = (x: Outcome): string | null => {
  const d = x.decision;
  if (!d || !x.scores) return null;
  const type = d.answers.itemType;
  return `Jev 中位 ${d.point} · P(≥${x.scores.threshold})=${atLeast(d.tail, x.scores.threshold).toFixed(2)} · ${type.choice} ${type.confidence.toFixed(2)}${d.answers.thin.noul >= 0.5 ? " thin" : ""}`;
};

const models = await evalModels(values.models, "score");

const report: Record<string, unknown> = {};
for (const model of models) {
  const started = performance.now();
  // Two gold cases can have different source metadata / thresholds while rendering the same score prompt.
  // Share only that score result (including a failure); prefilter and threshold semantics remain per case.
  const scoreRequests = new Map<string, Promise<{ scores: AnalysisRun["scores"]; receiptIds: number[]; error: string | null; decision?: ScoreDecision }>>();
  const results = await pmap(sample, concurrency, async (r): Promise<Outcome> => {
    const input = toInput(r);
    const receiptIds: number[] = [];
    let prefilterDecision: PrefilterDecision | undefined;
    let decision: ScoreDecision | undefined;
    const outcome = (relevance: Outcome["relevance"], scores: AnalysisRun["scores"] = null, error: string | null = null): Outcome =>
      ({ r, relevance, scores, receiptIds, error, prefilterDecision, decision });
    // Only a title: the site waits for material, without a model call.
    if (awaitsMaterial(input)) return outcome("unknown");
    try {
      if (prefilterModel) {
        try {
          prefilterDecision = await decidePrefilter(input, prefilterModel);
          receiptIds.push(prefilterDecision.receiptId);
        } catch (error) {
          const id = failedReceiptId(error);
          if (id !== null) receiptIds.push(id);
          throw error;
        }
      }
      const prefilter = prefilterDecision ?? (await runSelectionPrefilter(input, {}, (id) => receiptIds.push(id)));
      if (prefilter.label === "BLOCK") return outcome("block");
      const threshold = selectionThreshold(input.source);
      if (threshold === null) return outcome("pass");

      const key = buildScoreInput(input);
      let request = scoreRequests.get(key);
      if (!request) {
        const sharedReceiptIds: number[] = [];
        // Every score call, whatever the first says: a shared result serves cases at other thresholds, and the sweep.
        const asked = isDecisionModel(model)
          ? decisionScores(input, model, (id) => sharedReceiptIds.push(id))
          : runSelectionScores(input, { scoreModel: model, allScores: true }, (id) => sharedReceiptIds.push(id)).then((scores) => ({ scores, decision: undefined }));
        request = asked.then(
          ({ scores, decision }) => ({ scores, decision, receiptIds: sharedReceiptIds, error: null }),
          (error: unknown) => ({ scores: null, receiptIds: sharedReceiptIds, error: String(error).slice(0, 200) }),
        );
        scoreRequests.set(key, request);
      }
      const shared = await request;
      receiptIds.push(...shared.receiptIds);
      decision = shared.decision;
      if (shared.error) return outcome(null, null, shared.error);
      // Model output is independent of source tier; the decision threshold is not.
      return outcome("pass", shared.scores ? { ...shared.scores, threshold } : null);
    } catch (error) {
      return outcome(null, null, String(error).slice(0, 200));
    }
  });
  const metrics = selectionMetrics(results.map((x) => ({ gold: x.r.gold.decision, decision: decide(x) })));
  const mistakes: Array<Record<string, unknown>> = [];
  for (const x of results) {
    const pred = decide(x);
    const gold = x.r.gold.decision;
    if (pred === null || gold === "either") continue;
    if (pred === "select" && gold === "reject") mistakes.push({ kind: "FP", title: x.r.material.title, score: shownScore(deciding(x.scores)), stratum: x.r.samplingContext?.samplingStratum ?? null });
    else if (pred === "reject" && gold === "select") mistakes.push({ kind: "FN", title: x.r.material.title, score: shownScore(deciding(x.scores)), relevance: x.relevance, stratum: x.r.samplingContext?.samplingStratum ?? null });
  }
  const usage = await usageFor(results.flatMap((x) => x.receiptIds));
  // How often production would ask the second score, and how often deciding on the first alone changes a decision.
  const scored = results.filter((x) => x.error === null && x.scores && !x.scores.refused && x.scores.values.length > 1);
  const rate = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 1000 : null);
  // Where a decision model would hand over to the score step: not sure at every line at the floor.
  const decided = results.filter((x) => x.error === null && x.decision && x.scores);
  const alone = decided.filter((x) => decidesAlone(x.decision!, floors.score, x.scores!.threshold));
  const aloneDecisive = alone.filter((x) => x.r.gold.decision !== "either");
  const asked = results.filter((x) => x.prefilterDecision);
  const summary = {
    model,
    ...metrics,
    secondScoreRate: rate(scored.filter((x) => deciding(x.scores)!.values.length > 1).length, scored.length),
    flipsVsBoth: scored.filter((x) => decide(x) !== decide(x, true)).length,
    ...(decided.length ? {
      floor: floors.score,
      cascadeRate: rate(decided.length - alone.length, decided.length),
      aloneAccuracy: rate(aloneDecisive.filter((x) => decide(x) === x.r.gold.decision).length, aloneDecisive.length),
    } : {}),
    ...(asked.length ? { prefilterCascadeRate: rate(asked.filter((x) => !decidesAlone(x.prefilterDecision!, floors.prefilter)).length, asked.length) } : {}),
    ...usage,
    wallSeconds: Math.round((performance.now() - started) / 1000),
  };
  console.log(JSON.stringify(summary));
  // Threshold sweep keeps valid-output metrics, while coverage and completeAcc charge decisive failures.
  const thresholdCases = results.map((x) => ({ gold: x.r.gold.decision, available: x.error === null, passed: x.relevance === "pass", scores: x.scores }));
  const sweep = [];
  for (let t = defaults.sweep[0]; t <= defaults.sweep[1]; t += 2) {
    sweep.push(selectionThresholdMetrics(thresholdCases, t));
  }
  console.log(sweep.map((s) =>
    `  t=${s.t} acc=${s.acc} completeAcc=${s.completeAcc} coverage=${s.coverage} P=${s.P} R=${s.R} F1=${s.F1} sel=${s.sel}`
  ).join("\n"));
  const cases = results.map((x) => ({
    caseId: x.r.caseId,
    title: x.r.material.title,
    stratum: x.r.samplingContext?.samplingStratum ?? null,
    gold: x.r.gold.decision,
    decision: decide(x),
    score: shownScore(deciding(x.scores)),
    relevance: x.relevance,
    reason: x.decision ? jevReason(x) : axesReason(x.scores),
    receiptId: x.receiptIds[0] ?? null,
    error: x.error,
  }));
  report[model] = { summary, sweep, mistakes, cases };
}
const outDir = path.join(REPO_ROOT, ".data/eval");
mkdirSync(outDir, { recursive: true });
const splitName = safeReportNamePart(values.split!);
const file = path.join(outDir, `selection-${splitName}-${sample.length}-${Date.now()}.json`);
const meta = { split: values.split, n: sample.length, seed: Number(values.seed), promptVersion: SELECTION_PROMPT_VERSION, prefilter: prefilterModel, createdAt: new Date().toISOString() };
writeFileSync(file, JSON.stringify({ meta, models: report }, null, 2));
console.log(`report: ${file}`);
if (!values["no-import"]) {
  const run = await importSelectBenchRun({ meta, models: report }, values.label ?? `${values.split} ${sample.length} 条 · ${Object.keys(report).join(" / ")}`, "script:eval-selection");
  console.log(`SelectBench run: ${run.id}`);
}
await closeDb();
