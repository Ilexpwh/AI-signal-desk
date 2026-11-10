// A decision model's answers read as the score step decides (editorial/decisions.ts): the five axes'
// levels weighed by the site's weights into a distribution over the 0–100 total, thin material held to
// the cap, a fitted scale onto the score step's totals, and when it is sure enough to decide alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { atLeast, decidesAlone, medianTotal, scaled, scoreSure, scoreTail, type PrefilterDecision, type ScoreDecision } from "@aihot/backend/editorial/decisions";
import { AXES, UNDERSTAND_FLOOR } from "@aihot/backend/editorial/analyze";
import type { Answers } from "@aihot/backend/providers/typesafe";
import { DECISIONS } from "@aihot/industry/decisions";
import { SELECTION } from "@aihot/industry/selection";
import { ITEM_TYPES } from "@aihot/industry/taxonomy";

type ScoreAnswers = Answers<typeof DECISIONS.score>;
const LEVELS = DECISIONS.score.sig.criteria.length;
const level = (k: number) => Array.from({ length: LEVELS }, (_, j) => (j === k ? 1 : 0));
const mix = (ps: Record<number, number>) => Array.from({ length: LEVELS }, (_, j) => ps[j] ?? 0);

function answers(opts: { types?: Record<string, number>; axes?: Partial<Record<(typeof AXES)[number], number[]>>; at?: number; thin?: number } = {}): ScoreAnswers {
  const types = opts.types ?? { [ITEM_TYPES[0]]: 1 };
  const axis = (name: (typeof AXES)[number]) => {
    const probabilities = opts.axes?.[name] ?? level(opts.at ?? 2);
    return { type: "score" as const, score: probabilities.reduce((a, p, j) => a + p * j, 0), confidence: Math.max(...probabilities), probabilities };
  };
  return {
    itemType: { type: "choice", choice: Object.keys(types)[0]!, confidence: Math.max(...Object.values(types)), probabilities: types },
    sig: axis("sig"), nov: axis("nov"), cred: axis("cred"), reson: axis("reson"), act: axis("act"),
    thin: { type: "noul", noul: opts.thin ?? 0 },
  };
}

test("a level means the same total under every content type, since each type's weights add up to ten", () => {
  const top = LEVELS - 1;
  for (const k of [0, 1, top]) {
    const total = Math.round((10 * k * 10) / top);
    const tail = scoreTail(answers({ types: Object.fromEntries(ITEM_TYPES.map((t) => [t, 1 / ITEM_TYPES.length])), at: k }));
    assert.equal(medianTotal(tail), total, `level ${k} of ${top} on every axis is ${total}`);
    assert.ok(Math.abs(tail[total]! - 1) < 1e-9 && (total === 100 || tail[total + 1]! < 1e-9));
  }
});

test("the axes are weighed by the content type: an uncertain axis splits the total by its weight", () => {
  const type = ITEM_TYPES.find((t) => SELECTION.weights[t].sig > 0)!;
  const w = SELECTION.weights[type];
  const mid = (LEVELS - 1) / 2;
  // sig is the bottom or the top level at even odds, the other axes in the middle.
  const tail = scoreTail(answers({ types: { [type]: 1 }, at: mid, axes: { sig: mix({ 0: 0.5, [LEVELS - 1]: 0.5 }) } }));
  const rest = 5 * (10 - w.sig);
  const low = rest;
  const high = rest + 10 * w.sig;
  assert.ok(Math.abs(tail[low]! - 1) < 1e-9);
  assert.ok(Math.abs(tail[low + 1]! - 0.5) < 1e-9 && Math.abs(tail[high]! - 0.5) < 1e-9);
  assert.ok(high === 100 || tail[high + 1]! < 1e-9);
  assert.equal(medianTotal(tail), high, "the median is the highest total reached with at least even odds");
});

test("thin material is held to the cap with its probability", () => {
  const sure = scoreTail(answers({ at: LEVELS - 1, thin: 1 }));
  assert.equal(medianTotal(sure), SELECTION.thinCap);
  const half = scoreTail(answers({ at: LEVELS - 1, thin: 0.5 }));
  assert.ok(Math.abs(half[SELECTION.thinCap]! - 1) < 1e-9);
  assert.ok(Math.abs(half[SELECTION.thinCap + 1]! - 0.5) < 1e-9 && Math.abs(half[100]! - 0.5) < 1e-9);
});

test("a scale lifts totals onto the score step's, in straight lines between its points and flat past its ends", () => {
  assert.equal(scaled(37, []), 37, "no scale leaves the total");
  const scale: Array<[number, number]> = [[20, 10], [60, 70], [90, 95]];
  assert.deepEqual([scaled(0, scale), scaled(40, scale), scaled(75, scale), scaled(100, scale)], [10, 40, 82.5, 95]);
  // P(score ≥ 70) is P(total ≥ 60) once 60 maps to 70: here the middle level (50) or the top (100) at even odds.
  const tail = scoreTail(answers({ axes: Object.fromEntries(AXES.map((a) => [a, mix({ [(LEVELS - 1) / 2]: 0.5, [LEVELS - 1]: 0.5 })])) }));
  assert.equal(atLeast(tail, 70, scale), tail[60]);
  assert.ok(tail[60]! > 0 && tail[60]! < 1);
  assert.equal(atLeast(tail, 99, scale), 0, "a line the scale never reaches is never met");
});

test("it decides alone only when sure on every line the score decides, and never without a floor", () => {
  const threshold = Math.max(UNDERSTAND_FLOOR, SELECTION.browseFloor) + 10;
  const far = scoreTail(answers({ at: LEVELS - 1 }));
  assert.equal(scoreSure(far, 0.99, threshold, []), true);
  // Even odds of a total just under or just over the threshold.
  const straddling = new Array<number>(101).fill(0).map((_, k) => (k <= threshold - 1 ? 1 : k <= threshold + 1 ? 0.5 : 0));
  assert.equal(scoreSure(straddling, 0.6, threshold, []), false);
  const decision = { point: 100, tail: far, answers: answers(), model: "jev", receiptId: 1, reused: false } satisfies ScoreDecision;
  assert.equal(decidesAlone(decision, null, threshold), false);
  const prefilter = { label: "PASS", answer: { type: "choice", choice: "PASS", confidence: 0.92, probabilities: { PASS: 0.92, BLOCK: 0.05, UNKNOWN: 0.03 } }, model: "jev", receiptId: 1, reused: false } satisfies PrefilterDecision;
  assert.deepEqual([decidesAlone(prefilter, 0.9), decidesAlone(prefilter, 0.95), decidesAlone(prefilter, null)], [true, false, false]);
});
