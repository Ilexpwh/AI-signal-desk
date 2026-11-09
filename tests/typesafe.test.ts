// Jev (providers/typesafe.ts) through receipts, and its shadow of the model steps (editorial/shadow.ts):
// the questions go to /systemone with the preset's key, usage and an estimated cost stay on the receipt,
// the same question set about the same material is paid once, the valve and refusals are respected, and
// the shadow asks once per judged article, writes no analyses and runs only while switched on.
import { pointModels, Reply, stub, tag } from "./setup.ts";
import { config as appConfig } from "@aihot/backend/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { loadAnalyzeInput, selectionThreshold } from "@aihot/backend/editorial/analyze";
import { DECISION_VERSIONS, decidePrefilter, decideScore } from "@aihot/backend/editorial/decisions";
import { shadowDecisions } from "@aihot/backend/editorial/shadow";
import { modelsOverview, setShadow, switchModel } from "@aihot/backend/admin/models";
import { ensureDecisionBudget } from "@aihot/backend/providers/typesafe";
import { ModelOutputError, ModelUnavailableError, ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { MODELS } from "@aihot/backend/providers/llm";
import { DECISIONS } from "@aihot/industry/decisions";

const T = tag();
const SOURCE = `test-typesafe-${T}`;
const JEV = MODELS.jev!;
const LEVELS = DECISIONS.score.sig.criteria.length;
const INPUT_TOKENS = 1200;

interface Asked { url: string; auth: string | undefined; body: { model: string; state: string; questions: Record<string, { type: string; criteria: unknown }> } }
const asked: Asked[] = [];
/** What the stub answers next: well-formed answers, a refusal, or an option nobody asked for. */
let mode: "ok" | "refuse" | "garbled" = "ok";

// Every question answered for certain: the first option, the next-to-top level, not thin.
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as Asked["body"];
  asked.push({ url: req.url, auth: req.headers.authorization, body });
  if (mode === "refuse") return new Reply(422, { error: { message: "questions are not valid" } });
  const answers = Object.fromEntries(Object.entries(body.questions).map(([name, q]) => {
    if (q.type === "noul") return [name, { noul: 0 }];
    if (q.type === "choice") {
      const options = Object.keys(q.criteria as Record<string, string>);
      const choice = mode === "garbled" ? "SOMETHING_ELSE" : options[0]!;
      return [name, { choice, confidence: 1, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 1 : 0])) }];
    }
    const top = (q.criteria as string[]).length - 2;
    return [name, { score: top, confidence: 1, legend: q.criteria, probabilities: Object.fromEntries((q.criteria as string[]).map((_, i) => [String(i), i === top ? 1 : 0])) }];
  }));
  return { model: "jev-test", answers, usage: { input_tokens: INPUT_TOKENS, output_tokens: 0 } };
});
pointModels(provider.url, ["jev"]);

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test decisions source', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await closeDb();
});

const LONG = "a lab released a model with a benchmark table and pricing details. ".repeat(6);
const article = async (marker: string) =>
  (await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${marker}-${T}`, title: `${marker} model release ${T}`, bodyText: `${marker}: ${LONG} (${T})`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date("2026-10-28T01:02:03Z"),
  } as never)).articleId;
const input = async (id: string) => (await loadAnalyzeInput(id))!;
const receiptsOf = (id: string) => sql<{ purpose: string; status: string; usage: Record<string, number> | null; cost: string | null; currency: string | null; cost_basis: string | null; request: { promptVersion: string } }[]>`
  SELECT purpose, status, usage, cost, currency, cost_basis, request FROM receipts WHERE service = ${JEV.service} AND subject LIKE ${`article:${id}@%`} ORDER BY id`;

test("the questions go to /systemone with the key; usage and an estimated cost stay on the receipt, and the same questions are paid once", async () => {
  const id = await article("ASK");
  const a = await input(id);
  const before = provider.hits();
  const prefilter = await decidePrefilter(a, "jev");
  assert.equal(prefilter.label, Object.keys(DECISIONS.prefilter.relevance.criteria)[0]);
  const sent = asked.at(-1)!;
  assert.equal(sent.url, "/v1/systemone");
  assert.equal(sent.auth, "Bearer test-key");
  assert.equal(sent.body.model, JEV.model);
  assert.ok(sent.body.state.includes(`ASK model release ${T}`), "the material is the state");
  assert.deepEqual(Object.keys(sent.body.questions), Object.keys(DECISIONS.prefilter));

  const score = await decideScore(a, "jev");
  // Every axis at the next-to-top level, whatever the type's weights.
  assert.equal(score.point, Math.round((100 * (LEVELS - 2)) / (LEVELS - 1)));
  assert.equal(provider.hits(), before + 2);

  const [p, s] = await receiptsOf(id);
  assert.deepEqual([p!.purpose, s!.purpose], ["prefilter_article", "score_article"], "the step's purposes, so the models page shows them beside the step");
  assert.deepEqual([p!.request.promptVersion, s!.request.promptVersion], [DECISION_VERSIONS.prefilter, DECISION_VERSIONS.score]);
  assert.equal(p!.usage?.input_tokens, INPUT_TOKENS);
  assert.ok(Math.abs(Number(p!.cost) - (INPUT_TOKENS / 1e6) * 0.042) < 1e-6, "input tokens at the price per million");
  assert.deepEqual([p!.currency, p!.cost_basis], ["USD", "estimated"]);

  const again = await decidePrefilter(a, "jev");
  assert.equal(again.reused, true);
  assert.equal(provider.hits(), before + 2, "the receipt answers again without a call");
});

test("with the valve off nothing is sent; a refusal and an answer outside the options fail and leave a failed receipt", async () => {
  const a = await input(await article("FAIL"));
  const before = provider.hits();
  appConfig.modelCallsEnabled = false;
  try {
    await assert.rejects(decidePrefilter(a, "jev"), ModelUnavailableError);
  } finally {
    appConfig.modelCallsEnabled = true;
  }
  assert.equal(provider.hits(), before);

  mode = "refuse";
  try {
    await assert.rejects(decidePrefilter(a, "jev"), (error: unknown) => error instanceof ProviderRejectedError && !error.retryable);
  } finally {
    mode = "ok";
  }
  mode = "garbled";
  try {
    await assert.rejects(decideScore(a, "jev"), ModelOutputError);
  } finally {
    mode = "ok";
  }
  const statuses = (await receiptsOf(a.id)).map((r) => [r.purpose, r.status]);
  assert.deepEqual(statuses, [["prefilter_article", "failed"], ["score_article", "failed"]]);
});

test("the worker adds the decision service's budget once and keeps an operator's limits", async () => {
  await ensureDecisionBudget();
  const [added] = await sql<{ per_day: number }[]>`SELECT per_day FROM budgets WHERE service = ${JEV.service}`;
  assert.ok(added && added.per_day > 0);
  await sql`UPDATE budgets SET per_day = 7 WHERE service = ${JEV.service}`;
  await ensureDecisionBudget();
  const [kept] = await sql<{ per_day: number }[]>`SELECT per_day FROM budgets WHERE service = ${JEV.service}`;
  assert.equal(kept!.per_day, 7);
  await sql`UPDATE budgets SET per_day = ${added!.per_day} WHERE service = ${JEV.service}`;
});

test("a shadow asks once about each judged article, writes no analyses, and runs only while switched on", async () => {
  const id = await article("SHADOW");
  const a = await input(id);
  const threshold = selectionThreshold({ tier: "T1" })!;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, model, relevance, score, selected, output)
    VALUES (${id}, ${a.revision}, 'model', 'glm-5.3-flash-selection', 'pass', ${threshold}, true,
            ${sql.json({ prefilter: { label: "PASS" }, scores: [threshold, threshold], threshold })})`;
  const analyses = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analyses WHERE article_id = ${id}`)[0]!.n;

  const before = provider.hits();
  assert.deepEqual(await shadowDecisions(), { asked: 0, failed: 0 }, "off without its switch");
  assert.equal(provider.hits(), before);

  await assert.rejects(setShadow("score", "deepseek-flash", "test", "test"), /not a decision model/);
  await assert.rejects(setShadow("understand", "jev", "test", "test"), /no decision questions/);
  await assert.rejects(switchModel("score", "jev", "test", "test"), /only runs in shadow/);
  await setShadow("score", "jev", "trying Jev on scores", "test");

  const first = await shadowDecisions();
  assert.equal(first.asked, 1);
  assert.equal(provider.hits(), before + 1, "the score questions only: the prefilter is not shadowed");
  assert.deepEqual((await receiptsOf(id)).map((r) => r.purpose), ["score_article"]);
  assert.equal(await analyses(), 1, "no analysis is written");
  assert.deepEqual(await shadowDecisions(), { asked: 0, failed: 0 }, "an article is asked about once");

  const overview = await modelsOverview(1);
  const step = overview.capabilities.find((c) => c.key === "score")!;
  assert.deepEqual([step.decisions, step.shadow], [true, "jev"]);
  const jevUsage = step.usage.find((u) => u.model === JEV.model)!;
  assert.ok(jevUsage.tokensIn >= INPUT_TOKENS && jevUsage.tokensIn % INPUT_TOKENS === 0, "a decision service's input tokens count as the step's");
  assert.ok(jevUsage.estimatedCost! > 0);
  assert.equal(overview.choices.find((c) => c.key === "jev")?.decision, true);
  assert.equal(overview.history[0]?.subject, "shadow:score");

  await setShadow("score", null, "done", "test");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, output)
    VALUES (${await article("LATER")}, 1, 'model', 'pass', ${sql.json({ prefilter: { label: "PASS" }, scores: [threshold, threshold], threshold })})`;
  assert.deepEqual(await shadowDecisions(), { asked: 0, failed: 0 }, "switched off, a new judgement is not asked about");
  assert.equal((await modelsOverview(1)).capabilities.find((c) => c.key === "score")!.shadow, null);
});
