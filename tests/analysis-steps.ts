// Which step of the article analysis a model request is for, and a score that selects. Each step sends
// its own system prompt, rendered from the industry pack, and the thresholds come from the pack too: a
// test that recognises a request by its whole prompt and scores against the pack's threshold keeps
// working when a site rewrites the prompts and recalibrates the thresholds for its own industry.
import { MEND_SYSTEM, SCORE_SYSTEM, selectionThreshold, STRUCTURE_SYSTEM, VERIFY_SYSTEM, weighedScore, type ScoreAxes } from "@aihot/backend/editorial/analyze";
import { PREFILTER_SYSTEM, UNDERSTAND_SYSTEM } from "@aihot/backend/editorial/writing";
import { ITEM_TYPES } from "@aihot/industry/taxonomy";

export type AnalysisStep = "prefilter" | "score" | "structure" | "understand" | "summarize" | "wording" | "verify";

const BY_SYSTEM = new Map<string, AnalysisStep>([
  [PREFILTER_SYSTEM, "prefilter"], [SCORE_SYSTEM, "score"], [STRUCTURE_SYSTEM, "structure"], [UNDERSTAND_SYSTEM, "understand"], [MEND_SYSTEM, "wording"],
  [VERIFY_SYSTEM, "verify"],
]);

/** The step of a chat request, from its body as the provider receives it; the title/summary prompt comes without a system message. */
export function analysisStep(body: string): AnalysisStep {
  const { messages } = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
  if (messages[0]?.role !== "system") return "summarize";
  const step = BY_SYSTEM.get(String(messages[0].content));
  if (!step) throw new Error(`not a request of the article analysis: ${String(messages[0].content).slice(0, 80)}`);
  return step;
}

const AXES = ["sig", "nov", "cred", "reson", "act"] as const;

/**
 * A score call's answer whose axes weigh to `score` under the pack's weights (industry/selection.ts), as
 * level as those weights allow, so a test keeps its score when a site reweighs the types.
 */
export function scoreAnswer(score: number, opts: { thin?: boolean; itemType?: (typeof ITEM_TYPES)[number] } = {}): ScoreAxes {
  const level = Math.floor(score / 10);
  let best: ScoreAxes | null = null;
  let bestSpread = Infinity;
  for (const itemType of opts.itemType ? [opts.itemType] : ITEM_TYPES) {
    for (let n = 0; n < 5 ** AXES.length; n++) {
      const values = AXES.map((_, i) => Math.min(10, Math.max(0, level + (Math.floor(n / 5 ** i) % 5) - 2)));
      const answer = { itemType, ...Object.fromEntries(AXES.map((k, i) => [k, values[i]])), thin: false } as ScoreAxes;
      if (weighedScore(answer) !== score) continue;
      const spread = values.reduce((s, v) => s + Math.abs(v - level), 0);
      if (spread < bestSpread) [best, bestSpread] = [answer, spread];
    }
  }
  if (!best) throw new Error(`no axes weigh to ${score} under industry/selection.ts`);
  return { ...best, thin: opts.thin ?? false };
}

/** Both score calls at the T1 threshold: material from a T1 source is selected, with this mean score. */
export const SELECTING_SCORE = selectionThreshold({ tier: "T1" })!;
/** The score call's answer for SELECTING_SCORE. */
export const SELECTING_ANSWER = scoreAnswer(SELECTING_SCORE);
