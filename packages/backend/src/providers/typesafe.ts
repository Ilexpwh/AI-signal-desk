// Jev (TypeSafe's System One) through receipts: typed questions about one piece of material, each answered
// with probabilities instead of text (POST {base}/systemone; the site's preset names the address and key
// variables, TYPESAFE_BASE_URL / TYPESAFE_API_KEY). Questions are versioned by the caller; the raw answer
// and its usage are kept on the receipt as Jev returned them.
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { assertAccepted, ModelOutputError, ModelUnavailableError, paidRequest, rejectReceivedResponse } from "./receipts.ts";
import { MODELS } from "./llm.ts";

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: readonly string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

export interface ChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
/** `probabilities[k]` is the chance of level k (the question's k-th criterion); `score` is their weighted mean. */
export interface ScoreAnswer { type: "score"; score: number; confidence: number; probabilities: number[] }
/** `noul` is the chance of yes. */
export interface NoulAnswer { type: "noul"; noul: number }

export type AnswerTo<Q extends Question> = Q extends { type: "choice" } ? ChoiceAnswer : Q extends { type: "score" } ? ScoreAnswer : NoulAnswer;
export type Answers<Qs extends Record<string, Question>> = { [K in keyof Qs]: AnswerTo<Qs[K]> };

/** USD per million input tokens (TypeSafe's price page; output tokens are free). */
const INPUT_PRICE = 0.042;
const TIMEOUT_MS = 60_000;

/** Whether a registered model is a decision service rather than a chat model. */
export const isDecisionModel = (model: string) => MODELS[model]?.api === "systemone";

/** The circuit breaker for decision services, added at worker start (migrations add no rows); an operator's row is kept. */
export async function ensureDecisionBudget() {
  const services = [...new Set(Object.values(MODELS).filter((m) => m.api === "systemone").map((m) => m.service))];
  for (const service of services) {
    await sql`
      INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${service}, 100, 2000, 10000, '判断题调用熔断（Jev）')
      ON CONFLICT (service) DO NOTHING`;
  }
}

const probability = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 1 ? v : null);
const sumsToOne = (ps: number[]) => Math.abs(ps.reduce((a, b) => a + b, 0) - 1) <= 0.02;

/** One answer checked against the question that was asked; throws when it does not fit. */
export function readAnswer<Q extends Question>(question: Q, raw: unknown): AnswerTo<Q> {
  const a = (raw ?? {}) as Record<string, unknown>;
  if (question.type === "noul") {
    const p = probability(a.noul);
    if (p === null) throw new Error("noul answer without a probability");
    return { type: "noul", noul: p } as AnswerTo<Q>;
  }
  const confidence = probability(a.confidence);
  const given = (a.probabilities ?? {}) as Record<string, unknown>;
  if (confidence === null || typeof given !== "object") throw new Error(`${question.type} answer without confidence or probabilities`);
  if (question.type === "choice") {
    const names = Object.keys(question.criteria);
    const probabilities = Object.fromEntries(names.map((n) => [n, probability(given[n]) ?? 0]));
    if (!names.includes(String(a.choice)) || !sumsToOne(Object.values(probabilities))) throw new Error("choice answer outside the options asked");
    return { type: "choice", choice: String(a.choice), confidence, probabilities } as AnswerTo<Q>;
  }
  const probabilities = question.criteria.map((_, k) => probability(given[String(k)]) ?? 0);
  const score = Number(a.score);
  if (!Number.isFinite(score) || score < 0 || score > question.criteria.length - 1 || !sumsToOne(probabilities)) throw new Error("score answer outside the levels asked");
  return { type: "score", score, confidence, probabilities } as AnswerTo<Q>;
}

/** Every answer of a stored response, each checked against its question; throws when one does not fit. */
export function readAnswers<Qs extends Record<string, Question>>(questions: Qs, response: unknown): Answers<Qs> {
  const answers = ((response ?? {}) as { answers?: Record<string, unknown> }).answers;
  return Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, readAnswer(q, answers?.[name])])) as Answers<Qs>;
}

/**
 * Asks a decision model the questions about `state`. A receipt per (model, version, state): the same
 * question set about the same material is paid once; `attemptTag` asks again on purpose.
 */
export async function askSystemOne<Qs extends Record<string, Question>>(
  model: string,
  req: { purpose: string; subject: string; version: string; state: unknown; questions: Qs; attemptTag?: string },
): Promise<{ answers: Answers<Qs>; model: string; receiptId: number; reused: boolean }> {
  const spec = MODELS[model];
  if (!spec || spec.api !== "systemone") throw new Error(`${model} is not a decision model`);
  if (!config.modelCallsEnabled) throw new ModelUnavailableError("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const base = credential("models", spec.baseUrlEnv) ?? "https://api.typesafe.ai/v1";
  const key = credential("models", spec.apiKeyEnv);
  if (!key) throw new ModelUnavailableError(`Model ${model} is not configured (${spec.apiKeyEnv})`);
  const receipt = await paidRequest(
    {
      service: spec.service, model: spec.model, purpose: req.purpose, subject: req.subject, attemptTag: req.attemptTag,
      identity: { model: spec.model, version: req.version, state: req.state },
      requestSummary: { promptVersion: req.version, questions: Object.keys(req.questions) },
    },
    async () => {
      const res = await fetch(`${base.replace(/\/$/, "")}/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: spec.model, state: req.state, questions: req.questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      assertAccepted(spec.service, res.status, text);
      let response: unknown;
      try { response = JSON.parse(text); }
      catch { response = { unparsable: text.slice(0, 20000) }; }
      const usage = response && typeof response === "object" && "usage" in response ? (response.usage as Record<string, unknown>) : null;
      const input = Number(usage?.input_tokens);
      return { response, usage, cost: Number.isFinite(input) ? { amount: (input / 1e6) * INPUT_PRICE, currency: "USD", basis: "estimated" as const } : null };
    },
  );
  try {
    const answers = readAnswers(req.questions, receipt.response);
    const answered = (receipt.response as { model?: unknown } | null)?.model;
    return { answers, model: typeof answered === "string" ? answered : spec.model, receiptId: receipt.receiptId, reused: receipt.reused };
  } catch (error) {
    await rejectReceivedResponse(receipt.receiptId, `unusable decision: ${String(error).slice(0, 500)}`);
    throw new ModelOutputError(`Decision response is unusable for ${req.subject}: ${String(error).slice(0, 300)}`, receipt.receiptId);
  }
}
