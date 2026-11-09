// Jev's answers to the site's decision questions (industry/decisions.ts), read the way the model steps decide:
// the prefilter's label, and the score as a distribution over the 0–100 total that the site's weights give
// (analyze.ts weighedScore), so it meets the same lines. The shadow sweep and the selection eval use it;
// nothing here writes analyses.
import { DECISIONS } from "@aihot/industry/decisions";
import { SELECTION } from "@aihot/industry/selection";
import { sha256, stableJson } from "../lib/ids.ts";
import { askSystemOne, type Answers, type ChoiceAnswer } from "../providers/typesafe.ts";
import { AXES, scoreMaterial, subjectOf, UNDERSTAND_FLOOR } from "./analyze.ts";
import { missingEvidence } from "./writing.ts";
import type { AnalyzeInputArticle } from "./input.ts";

/** The steps Jev can answer for, with their receipt purposes. */
export const DECISION_STEPS = { prefilter: "prefilter_article", score: "score_article" } as const;
export type DecisionStep = keyof typeof DECISION_STEPS;

const versionOf = (questions: unknown) => `jev-${sha256(stableJson({ questions, stateChars: DECISIONS.stateChars })).slice(0, 12)}`;
/** Changes with the questions, so changed questions are asked again instead of reusing old receipts. */
export const DECISION_VERSIONS: Record<DecisionStep, string> = { prefilter: versionOf(DECISIONS.prefilter), score: versionOf(DECISIONS.score) };

/** What Jev reads: the material the score step judges, its body cut at `stateChars`. */
export const decisionState = (a: AnalyzeInputArticle) => scoreMaterial(a, DECISIONS.stateChars);

export interface PrefilterDecision {
  label: "PASS" | "BLOCK" | "UNKNOWN";
  answer: ChoiceAnswer;
  model: string;
  receiptId: number;
  reused: boolean;
}

export async function decidePrefilter(a: AnalyzeInputArticle, model: string, attemptTag?: string): Promise<PrefilterDecision> {
  const res = await askSystemOne(model, {
    purpose: DECISION_STEPS.prefilter, subject: subjectOf(a), version: DECISION_VERSIONS.prefilter, state: decisionState(a), questions: DECISIONS.prefilter, attemptTag,
  });
  const answer = res.answers.relevance;
  // As the model step: a BLOCK without text to back it counts as UNKNOWN.
  const label = answer.choice === "BLOCK" && missingEvidence(a) ? "UNKNOWN" : (answer.choice as PrefilterDecision["label"]);
  return { label, answer, model, receiptId: res.receiptId, reused: res.reused };
}

export interface ScoreDecision {
  /** The median total on the score step's scale: the highest k with P(total ≥ k) ≥ 0.5. */
  point: number;
  /** tail[k] = P(total ≥ k) for k = 0…100, before `scale`. */
  tail: number[];
  answers: Answers<typeof DECISIONS.score>;
  model: string;
  receiptId: number;
  reused: boolean;
}

/**
 * P(total ≥ k) for k = 0…100: every content type at its probability, the five axes taken as independent (level j
 * of n worth 10·j/(n−1)), weighed by the type's weights, and held to `thinCap` with the probability of thin.
 */
export function scoreTail(answers: Answers<typeof DECISIONS.score>): number[] {
  const mass = new Map<number, number>();
  const put = (total: number, p: number) => mass.set(total, (mass.get(total) ?? 0) + p);
  const thin = answers.thin.noul;
  for (const [type, pType] of Object.entries(answers.itemType.probabilities)) {
    if (!pType) continue;
    const w = SELECTION.weights[type as keyof typeof SELECTION.weights];
    const walk = (axis: number, total: number, p: number) => {
      if (p === 0) return;
      if (axis === AXES.length) {
        put(total, p * (1 - thin));
        put(Math.min(total, SELECTION.thinCap), p * thin);
        return;
      }
      const levels = answers[AXES[axis]!].probabilities;
      levels.forEach((pl, j) => walk(axis + 1, total + ((10 * j) / (levels.length - 1)) * w[AXES[axis]!], p * pl));
    };
    walk(0, 0, pType);
  }
  const tail = new Array<number>(101).fill(0);
  for (const [total, p] of mass) for (let k = 0; k <= Math.min(100, Math.floor(total + 1e-9)); k++) tail[k]! += p;
  return tail.map((p) => Math.min(1, p));
}

/** A Jev total on the score step's scale (industry/decisions.ts `scale`, straight lines between its points). */
export function scaled(total: number, scale: Array<[number, number]> = DECISIONS.scale): number {
  if (!scale.length) return total;
  if (total <= scale[0]![0]) return scale[0]![1];
  for (let i = 1; i < scale.length; i++) {
    const [x0, y0] = scale[i - 1]!;
    const [x1, y1] = scale[i]!;
    if (total <= x1) return x1 === x0 ? y1 : y0 + ((total - x0) * (y1 - y0)) / (x1 - x0);
  }
  return scale[scale.length - 1]![1];
}

/** P(score ≥ line) on the score step's scale: the lowest Jev total that `scale` lifts to the line or above. */
export function atLeast(tail: number[], line: number, scale: Array<[number, number]> = DECISIONS.scale): number {
  for (let k = 0; k <= 100; k++) if (scaled(k, scale) >= line) return tail[k]!;
  return 0;
}

/** The median total: the highest k with P(total ≥ k) ≥ 0.5. */
export const medianTotal = (tail: number[]) => tail.reduce((best, p, k) => (p >= 0.5 ? k : best), 0);

/** The lines a score decides: the source's threshold (精选), the writing floor and the browse floor (全部动态). */
export const scoreLines = (threshold: number) => [threshold, UNDERSTAND_FLOOR, SELECTION.browseFloor];

/** Whether the score falls on one side of every line it decides with probability at least `floor`. */
export function scoreSure(tail: number[], floor: number, threshold: number, scale: Array<[number, number]> = DECISIONS.scale): boolean {
  return scoreLines(threshold).every((line) => {
    const p = atLeast(tail, line, scale);
    return Math.max(p, 1 - p) >= floor;
  });
}

export async function decideScore(a: AnalyzeInputArticle, model: string, attemptTag?: string): Promise<ScoreDecision> {
  const res = await askSystemOne(model, {
    purpose: DECISION_STEPS.score, subject: subjectOf(a), version: DECISION_VERSIONS.score, state: decisionState(a), questions: DECISIONS.score, attemptTag,
  });
  const tail = scoreTail(res.answers);
  return { point: Math.round(scaled(medianTotal(tail))), tail, answers: res.answers, model, receiptId: res.receiptId, reused: res.reused };
}

/**
 * Whether Jev is sure enough to decide alone at `floor` (industry/decisions.ts `confidence`): the prefilter's
 * choice at that probability, the score on the same side of the threshold, the writing floor and the
 * browse floor at that probability each. A null floor never decides alone.
 */
export function decidesAlone(d: PrefilterDecision, floor: number | null): boolean;
export function decidesAlone(d: ScoreDecision, floor: number | null, threshold: number): boolean;
export function decidesAlone(d: PrefilterDecision | ScoreDecision, floor: number | null, threshold?: number): boolean {
  if (floor === null) return false;
  return "label" in d ? d.answer.confidence >= floor : scoreSure(d.tail, floor, threshold!);
}
