// The judging and writing steps (editorial/analyze.ts): the prefilter decides relevance, two scores
// against the source's threshold (its tier's, raised by its class) decide 精选, selected and near-selected items are written by the content
// understanding and the rest by the title/summary translation, a structure step gives the category,
// subjects and fact. The content understanding's copy is checked against the material, only on record.
// Material with only a feed summary has its page fetched first. A reprint of an article another source
// already had judged takes that judgement without a model call.
import { pointModels, Reply, stub, tag } from "./setup.ts";
import { analysisStep, scoreAnswer, type AnalysisStep } from "./analysis-steps.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import {
  analyzeArticle, buildMaterial, decidingScores, loadAnalyzeInput, needsSecondScore, normalizeStructure, selectionThreshold, StructureSchema, UNDERSTAND_FLOOR, weighedScore,
  type ScoreAxes,
} from "@aihot/backend/editorial/analyze";
import { createSource, updateSource } from "@aihot/backend/admin/sources";
import { commitCopy, copyText, findOriginal, fingerprint } from "@aihot/backend/editorial/copies";
import { publishArticle } from "@aihot/backend/publication/publish";
import { processArticle, queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { compactAnswerFirstSummary, enforceIdentity, MAX_BODY_CHARS, parseTranslateOutput, subjectGuard } from "@aihot/backend/editorial/writing";
import { READER_WORDING } from "@aihot/industry/wording";
import { SELECTION } from "@aihot/industry/selection";
import { ITEM_TYPES } from "@aihot/industry/taxonomy";

const T = tag();
const SOURCE = `test-analyze-${T}`;
const X_SOURCE = `test-analyze-x-${T}`;
const CLASSED_SOURCE = `test-analyze-classed-${T}`;
const REPRINTER = `test-analyze-reprinter-${T}`;
const OFFICIAL = `test-analyze-official-${T}`;

interface Req { step: AnalysisStep; marker: string; user: string }
const requests: Req[] = [];
const MARKERS = ["CLEAR", "RESCUE", "LOW", "OFFTOPIC", "BARE", "VAGUE", "THIN", "SENSITIVE", "推文", "WORDY", "REFUSAL", "RENUMBER", "UNMENDED", "ECOSYS", "GARBLED", "DECISIVE", "BORDER", "REPRINT", "UNWANTED", "SWAPPED", "UNCHECKED"];
// The scores sit a few points around the pack's T1 threshold and understand floor, so each case means
// the same after a site recalibrates them: selected when the two add up to 2 × T1, written like a
// selected item when they add up to more than 2 × FLOOR, translated otherwise.
const T1 = selectionThreshold({ tier: "T1" })!;
const T2 = selectionThreshold({ tier: "T2" })!;
const FLOOR = UNDERSTAND_FLOOR;
// A pack class whose floor lies between the official and the media threshold: it raises the first, not the second.
const [CLASS, CLASS_FLOOR] = Object.entries(SELECTION.classes).map(([key, c]) => [key, c.threshold] as const).find(([, t]) => t > T1 && t < T2) ?? [undefined, NaN];
// Each score call answers with axes that weigh to the listed score; GARBLED's are marked too thin to judge.
const GARBLED = scoreAnswer(T1 + 10, { thin: true });
const scoreAnswers: Record<string, Array<number | ScoreAxes>> = {
  CLEAR: [T1 + 3, T1 - 1], RESCUE: [FLOOR + 1, FLOOR], LOW: [FLOOR, FLOOR - 1], THIN: [T1, T1], SENSITIVE: [T1, T1], 推文: [FLOOR, FLOOR],
  BARE: [FLOOR - 2, FLOOR - 4], VAGUE: [T1, T1 + 2], WORDY: [T1, T1], REFUSAL: [T1, T1], RENUMBER: [T1, T1], UNMENDED: [T1, T1],
  ECOSYS: [CLASS_FLOOR, CLASS_FLOOR - 1], GARBLED: [GARBLED, GARBLED], DECISIVE: [T1 + 10, T1 + 10], BORDER: [T1 + 2, T1 - 3],
  REPRINT: Array<number>(40).fill(T1 + 5), SWAPPED: [T1, T1], UNCHECKED: [T1, T1],
};

const WORDY = ["WORDY", "REFUSAL", "RENUMBER", "UNMENDED"];

// One stub stands in for DashScope (prefilter, structure), Zhipu (score, understand) and DeepSeek (summarize, verify).
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = analysisStep(req.body);
  const marker = MARKERS.find((m) => user.includes(m)) ?? "";
  requests.push({ step, marker, user });
  const answer = (content: unknown) => ({ id: `stub-${requests.length}`, model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return answer({ label: ["OFFTOPIC", "BARE", "UNWANTED"].includes(marker) ? "BLOCK" : marker === "VAGUE" ? "UNKNOWN" : "PASS", reason: "测试" });
  if (step === "score") {
    const next = scoreAnswers[marker]!.shift()!;
    return answer(typeof next === "number" ? scoreAnswer(next) : next);
  }
  // Copy with a word a site keeps from readers (added to the pack's list below), and its mended form: whole (WORDY),
  // refused by the provider, with a number changed, or with as many such words as before.
  if (step === "understand" && WORDY.includes(marker)) return answer({ itemType: ITEM_TYPES[0], authorRole: "principal", tags: [], editorialJudgment: `理由里有禁用词 ${marker}`, titleZh: `标题里有禁用词 ${marker}`, summaryZh: `${marker} 的摘要。第二句补充 3 个数字。` });
  // A refusal in a provider's own words: each provider words its own, and the same request would meet it again.
  if (step === "wording" && marker === "REFUSAL") return new Reply(400, { error: { message: "request refused", type: "invalid_request_error" } });
  if (step === "wording") {
    const unmended = marker === "UNMENDED" ? "有禁用词" : "换了说法";
    return answer({ titleZh: `标题里${unmended} ${marker}`, summaryZh: `${marker} 的摘要。第二句补充 ${marker === "RENUMBER" ? 4 : 3} 个数字。`, reasonZh: `理由里${unmended} ${marker}` });
  }
  // A title about the other of two companies the material names than the one its fact is about.
  if (step === "understand" && marker === "SWAPPED") return answer({ itemType: "model_release", authorRole: "observer", tags: [], editorialJudgment: "理由 SWAPPED", titleZh: "Anthropic 发布新模型 SWAPPED", summaryZh: "SWAPPED 的摘要。第二句补充一个关键数字。" });
  if (step === "understand") {
    if (marker === "SENSITIVE") return new Reply(400, { contentFilter: [{ level: 1, role: "user" }], error: { code: "1301", message: "系统检测到输入或生成内容可能包含不安全或敏感内容" } });
    return answer({ itemType: "model_release", authorRole: "principal", tags: ["模型发布", "开源", "Agent", "不存在的标签"], editorialJudgment: `理由 ${marker}`, titleZh: `理解标题 ${marker}`, summaryZh: `理解摘要 ${marker}。第二句补充一个关键数字。` });
  }
  if (step === "structure") return answer({ category: "ai-models", tags: ["模型发布", "推理"], subjects: ["anthropic", "unknown-co"], scope: "single", fact: { title: `事实 ${marker}`, subject: marker === "SWAPPED" ? "OpenAI" : "某公司", action: "发布", object: "模型", occurredAt: null, evidence: "a lab released a model", conditions: [] } });
  // The check of the copy: a claim the material backs, one backed by a sentence it does not have, one it does not support.
  if (step === "verify") return marker === "UNCHECKED" ? answer("这不是 JSON") : answer({ claims: [
    { part: "title", text: `发布新模型 ${marker}`, verdict: "supported", quote: "a lab released a model with a benchmark table" },
    { part: "summary", text: "对所有人免费", verdict: "supported", quote: "the model is free for everyone" },
    { part: "summary", text: "补充一个关键数字", verdict: "unsupported", quote: "" },
  ] });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
pointModels(provider.url);

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${SOURCE}, 'Test analyze source', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${X_SOURCE}, 'Test X account', 'x_search', 'T1', 'editorial', '2100-01-01'),
    (${CLASSED_SOURCE}, 'Test official source that gets a class', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${REPRINTER}, 'Test media that reprints', 'rss', 'T2', 'editorial', '2100-01-01'),
    (${OFFICIAL}, 'Test second official source', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

// The tag keeps each material unique: identical input would reuse an earlier run's paid answers.
const LONG = "a lab released a model with a benchmark table and pricing details. ".repeat(8);
const article = async (marker: string, extra: Record<string, unknown> = {}) =>
  (await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${marker}-${T}`, title: `${marker} model release ${T}`, bodyText: `${marker}: ${LONG} (${T})`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date("2026-09-28T01:02:03Z"), ...extra,
  } as never)).articleId;
const calls = (marker: string) => requests.filter((r) => r.marker === marker).map((r) => r.step);
const row = async (id: string) =>
  (await sql<{ selected: boolean; relevance: string; score: string | null; title_zh: string; reason_zh: string | null; category: string | null; tags: string[]; subjects: string[]; receipt_ids: string[]; output: Record<string, any> }[]>`
    SELECT selected, relevance, score, title_zh, reason_zh, category, tags, subjects, receipt_ids, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!;

test("a selected item: prefilter, two scores, the content understanding and the structure", async () => {
  assert.ok(FLOOR >= 4 && FLOOR < T1 && T1 <= 97, "the cases need the understand floor below the T1 threshold, and a few points either side");
  const id = await article("CLEAR");
  const res = await analyzeArticle(id);
  assert.deepEqual([res!.output!.selected, res!.output!.score], [true, T1 + 1], `${T1 + 3} + ${T1 - 1} >= 2 × ${T1}; the mean is shown`);
  assert.deepEqual(calls("CLEAR").sort(), ["prefilter", "score", "score", "structure", "understand", "verify"]);
  const r = await row(id);
  assert.deepEqual([r.title_zh, r.reason_zh, r.category, r.receipt_ids.length], ["理解标题 CLEAR", "理由 CLEAR", "ai-models", 6]);
  // Failure case: the writer's independent labels contradict the structural category.
  assert.deepEqual(r.tags, ["模型发布", "推理", "Anthropic"], "category and tags come from the same structural judgement, plus the verified subject tag");
  assert.deepEqual(r.subjects, ["anthropic"]);
  assert.deepEqual([r.output.writer, r.output.itemType, r.output.prefilter.label, r.output.fact.title], ["understand", "model_release", "PASS", "事实 CLEAR"]);
  assert.equal(r.output.scope, "single");
  assert.equal(r.output.fact.evidence, "a lab released a model");
  assert.deepEqual(r.output.unmatchedSubjects, ["某公司"], "a fact subject the company list does not know is kept for the admin");
  assert.deepEqual(r.output.scoreAxes.map(weighedScore), r.output.scores, "each call's type and axes are kept, and weigh to its score");
  const score = requests.find((q) => q.marker === "CLEAR" && q.step === "score")!;
  assert.match(score.user, /【标题】\nCLEAR model release/, "the score reads the original title, before any writing");
});

test("the score is the type's weighted axes, held low when the material is too thin to judge", async () => {
  assert.ok(SELECTION.thinCap < FLOOR && T1 + 10 <= 100, "the case needs the thin cap below the understand floor");
  const id = await article("GARBLED");
  const res = await analyzeArticle(id);
  assert.deepEqual([res!.output!.selected, res!.output!.score], [false, SELECTION.thinCap], `axes worth ${T1 + 10} count as ${SELECTION.thinCap}`);
  assert.deepEqual(calls("GARBLED").sort(), ["prefilter", "score", "score", "structure", "summarize"], "written by the cheaper title/summary prompt");
  assert.equal((await row(id)).output.scoreAxes[0].thin, true);
});

test("a first score far from every line a score decides is the only one asked", async () => {
  const pack = SELECTION as { secondScoreWithin: number };
  const within = pack.secondScoreWithin;
  pack.secondScoreWithin = 5; // a margin a site could calibrate
  try {
    assert.ok(!needsSecondScore(T1 + 10, T1) && needsSecondScore(T1 + 2, T1), "the cases need T1 + 10 far from the threshold and both floors, T1 + 2 near");
    const far = await article("DECISIVE");
    const res = await analyzeArticle(far);
    assert.deepEqual([res!.output!.selected, res!.output!.score, res!.output!.scores], [true, T1 + 10, [T1 + 10]]);
    assert.deepEqual(calls("DECISIVE").sort(), ["prefilter", "score", "structure", "understand", "verify"], "one score call");
    assert.equal((await row(far)).receipt_ids.length, 5);
    const near = await analyzeArticle(await article("BORDER"));
    assert.deepEqual([near!.output!.selected, near!.output!.scores], [false, [T1 + 2, T1 - 3]], "near the threshold the second score is asked, and the mean decides");
    // An evaluation asks both, then replays what production would have decided at each threshold.
    const both = { model: "m", threshold: T1, values: [T1 + 10, T1 - 20], axes: [scoreAnswer(T1 + 10), scoreAnswer(T1 - 20)], receiptIds: [1, 2], reused: true };
    assert.deepEqual(decidingScores(both, T1)!.values, [T1 + 10], "far from every line, the first decides alone");
    assert.deepEqual(decidingScores(both, T1 + 9)!.values, [T1 + 10, T1 - 20], "near a threshold being swept, both decide");
  } finally {
    pack.secondScoreWithin = within;
  }
});

test("a word the site keeps from readers goes back once to be changed; copy without one is not sent", async () => {
  // A word only this test bans: the pack's list is the site's own (empty in the template).
  (READER_WORDING as Array<readonly [RegExp, string]>).push([/禁用词/u, "换一个说法"]);
  try {
    const id = await article("WORDY");
    await analyzeArticle(id);
    assert.equal(calls("WORDY").filter((s) => s === "wording").length, 1);
    const r = await row(id);
    assert.deepEqual([r.title_zh, r.reason_zh], ["标题里换了说法 WORDY", "理由里换了说法 WORDY"], "the mended copy is stored");
    const sent = requests.find((q) => q.marker === "WORDY" && q.step === "wording")!;
    assert.ok(sent.user.includes("标题用了“禁用词”") && sent.user.includes("推荐理由用了“禁用词”"), "each use named");
    assert.ok(!requests.some((q) => q.step === "wording" && q.marker !== "WORDY"), "the other items' copy uses none");
  } finally {
    (READER_WORDING as Array<readonly [RegExp, string]>).pop();
  }
});

test("the first copy stands when the provider refuses the mend, the mend changes a number or leaves as many such words", async () => {
  (READER_WORDING as Array<readonly [RegExp, string]>).push([/禁用词/u, "换一个说法"]);
  try {
    for (const marker of ["REFUSAL", "RENUMBER", "UNMENDED"]) {
      const id = await article(marker);
      await analyzeArticle(id);
      const r = await row(id);
      assert.deepEqual([r.title_zh, r.reason_zh], [`标题里有禁用词 ${marker}`, `理由里有禁用词 ${marker}`], `${marker}: the first copy is stored`);
      assert.equal(calls(marker).filter((s) => s === "wording").length, 1, `${marker}: mended once`);
      const [receipt] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE purpose = 'mend_wording' AND subject LIKE ${`article:${id}@%`}`;
      assert.equal(receipt!.status, marker === "REFUSAL" ? "failed" : "completed", `${marker}: the mend's receipt`);
    }
  } finally {
    (READER_WORDING as Array<readonly [RegExp, string]>).pop();
  }
});

test("structure retains grounded conditions, rejects invented or unseen quotes, and does not infer missing scope", async () => {
  const input = (await loadAnalyzeInput(await article("CONDITIONS", {
    bodyText: "Preview is free for Pro users until October 10.\n" + "x".repeat(11000) + "\nOnly available in the US. " + "x".repeat(MAX_BODY_CHARS) + "This late detail was not sent.",
  })))!;
  input.translationZh = "仅中文译文中出现的限制";
  const frame = { title: "预览上线", evidence: "Preview is free for Pro users until October 10.", conditions: [
    { text: "仅Pro用户，免费至10月10日", quote: "Preview is free for Pro users until October 10." },
    { text: "仅限美国", quote: "Only available in the US." },
    { text: "无限免费", quote: "Unlimited free access for everyone." },
    { text: "不在模型输入里的句子", quote: "This late detail was not sent." },
  ] };
  const base = { category: "ai-models", tags: [], subjects: [], fact: frame };
  const out = normalizeStructure(StructureSchema.parse(base), input);
  assert.ok(buildMaterial(input).includes("Only available in the US."), "a condition after the old 7000-character cutoff reaches the model");
  assert.ok(buildMaterial(input).includes("后文未提供"));
  assert.equal(out.scope, "unknown", "an older result with a fact is not proof of single scope");
  assert.deepEqual(out.fact?.conditions, frame.conditions.slice(0, 2));
  assert.equal(out.fact?.evidence, frame.evidence);
  const partial = normalizeStructure(StructureSchema.parse({ ...base, fact: { ...frame, conditions: [
    { quote: "x".repeat(401) },
    { quote: "Preview is free... until October 10." },
    { quote: "Only available in the US." },
  ] } }), input);
  assert.deepEqual(partial.fact?.conditions, [{ text: "Only available in the US.", quote: "Only available in the US." }],
    "an invalid sibling cannot discard a valid original condition; spliced quotes remain rejected");
  const invented = normalizeStructure(StructureSchema.parse({ ...base, fact: { ...frame, evidence: input.source.name, conditions: [{ text: "翻译限制", quote: input.translationZh }] } }), input);
  assert.equal(invented.fact?.evidence, null, "source metadata is not original evidence");
  assert.deepEqual(invented.fact?.conditions, [], "a translation does not count as an original quote");
  assert.equal(normalizeStructure(StructureSchema.parse({ ...base, scope: "composite" }), input).fact, null, "composite output cannot also claim one fact");
  const titleOnly = normalizeStructure(StructureSchema.parse({ ...base, scope: "single" }), { ...input, bodyText: null, excerpt: null });
  assert.equal(titleOnly.scope, "unknown", "a confident model cannot supply the missing original material");
  assert.equal(titleOnly.fact, null);
  assert.deepEqual(titleOnly.unmatchedSubjects, [], "no fact, no subject to miss");
});

test("of a fact subject's names, those that are no company of the list are kept apart, each once", async () => {
  const input = (await loadAnalyzeInput(await article("SUBJECTS")))!;
  const subject = (s: string) => normalizeStructure(StructureSchema.parse({ category: "ai-models", tags: [], subjects: [], fact: { title: "发布", subject: s } }), input).unmatchedSubjects;
  assert.deepEqual(subject("Open AI、新锐实验室 / 月之暗面；新锐实验室"), ["新锐实验室"], "a known name in another case or spacing is known");
  assert.deepEqual(subject("Anthropic"), []);
  assert.deepEqual(subject("OpenAI 研究团队"), ["OpenAI 研究团队"], "a name only containing a company's name is not that name");
});

test("a near-selected item is written like a selected one; below the floor it is translated", async () => {
  const near = await analyzeArticle(await article("RESCUE"));
  assert.deepEqual([near!.output!.selected, near!.output!.reasonZh], [false, "理由 RESCUE"], `${FLOOR + 1} + ${FLOOR} > 2 × ${FLOOR}`);
  const lowId = await article("LOW");
  const low = await analyzeArticle(lowId);
  assert.deepEqual([low!.output!.selected, low!.output!.titleZh, low!.output!.reasonZh], [false, "翻译标题 LOW", null]);
  assert.deepEqual(calls("LOW").sort(), ["prefilter", "score", "score", "structure", "summarize"], "the cheaper copy is not checked");
  assert.deepEqual((await row(lowId)).tags, ["模型发布", "推理", "Anthropic"], "structure tags");
});

test("the content understanding's copy is checked against the material once; the checks are only recorded", async () => {
  const id = await article("SWAPPED", { bodyText: `SWAPPED: OpenAI and Anthropic both shipped models this week. ${LONG} (${T})` });
  const res = await analyzeArticle(id);
  assert.equal(calls("SWAPPED").filter((s) => s === "verify").length, 1);
  const sent = requests.find((q) => q.marker === "SWAPPED" && q.step === "verify")!;
  assert.ok(sent.user.includes("OpenAI and Anthropic both shipped") && sent.user.includes("Anthropic 发布新模型 SWAPPED"), "it reads the material and the copy");
  const r = await row(id);
  assert.deepEqual([res!.output!.selected, r.title_zh], [true, "Anthropic 发布新模型 SWAPPED"], "readers get the copy as written");
  assert.deepEqual(r.output.subjectGuard, { outcome: "mismatch", factEntity: "openai", titleEntities: ["anthropic"] }, "the fact is OpenAI's, the title names Anthropic");
  assert.deepEqual(r.output.grounding.claims.map((c: { verdict: string; quote: string | null }) => [c.verdict, c.quote]), [
    ["supported", "a lab released a model with a benchmark table"],
    ["unclear", null],
    ["unsupported", null],
  ], "a quote the material does not have does not back a claim");
  assert.equal(r.receipt_ids.length, 6, "the check's receipt is completed with the judgement");
});

test("a check that cannot be had leaves the judgement and its copy as they are", async () => {
  const id = await article("UNCHECKED");
  const res = await analyzeArticle(id);
  const r = await row(id);
  assert.deepEqual([res!.output!.selected, r.relevance, r.title_zh, r.reason_zh], [true, "pass", "理解标题 UNCHECKED", "理由 UNCHECKED"]);
  assert.deepEqual(r.output.grounding, { failed: "unusable" });
  assert.equal(r.receipt_ids.length, 5);
  const [receipt] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE purpose = 'verify_copy' AND subject LIKE ${`article:${id}@%`}`;
  assert.equal(receipt!.status, "failed", "asked again the next time the item is analysed");
});

test("the prefilter's BLOCK stops everything; UNKNOWN with material goes on like PASS", async () => {
  const off = await analyzeArticle(await article("OFFTOPIC"));
  assert.deepEqual([off!.output!.relevance, off!.output!.selected], ["block", false]);
  assert.deepEqual(calls("OFFTOPIC"), ["prefilter"]);
  // An UNKNOWN with material is judged and written like a PASS, up to 精选 (T1 + T1 + 2 ≥ 2 × T1).
  const vagueId = await article("VAGUE");
  const vague = await analyzeArticle(vagueId);
  assert.deepEqual([vague!.output!.relevance, vague!.output!.selected, vague!.output!.titleZh], ["pass", true, "理解标题 VAGUE"]);
  assert.equal((await row(vagueId)).output.prefilter.label, "UNKNOWN", "the prefilter's own answer stays on record");
  // Nothing but a title and no page to fetch: it waits for material without a model call.
  const bare = await analyzeArticle(await article("BARE", { bodyText: null, excerpt: null, bodyStatus: "none" }));
  assert.deepEqual([bare!.output!.relevance, bare!.output!.selected, bare!.output!.score], ["unknown", false, null]);
  assert.deepEqual(calls("BARE"), []);
});

test("a feed summary alone: the article page is fetched first, then the whole article is judged", async () => {
  const id = await article("THIN", { bodyText: null, bodyStatus: "pending", excerpt: `THIN: a short feed summary (${T}).` });
  // The queue sends it to extraction although its source does not ask for full text (the sweep does
  // the same after a failed fetch, so extraction failures add up to "unconfirmed" and end).
  await queueProcessing(id);
  const [job] = await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId' = ${id}`;
  assert.equal(job?.name, QUEUES.extractBody);
  const first = await analyzeArticle(id);
  assert.deepEqual([first!.needsBody, first!.output], [true, null]);
  assert.deepEqual(calls("THIN"), [], "no model call before the page");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${id}`).length, 0, "nothing committed");
  // What extraction does: the body lands as a new revision.
  await sql`UPDATE articles SET body_text = ${`THIN: ${LONG} (${T}) full page`}, body_status = 'ok', revision = revision + 1 WHERE id = ${id}`;
  const second = await analyzeArticle(id);
  assert.deepEqual([second!.needsBody ?? false, second!.output!.selected], [false, true]);
});

test("a short post in Chinese is its own copy; a content-filter refusal is translated instead", async () => {
  // The tag rides as a hashtag, which the language check strips.
  const text = `推文：今天把智能体接进了工作流，效果不错。#t${T}`;
  const { articleId } = await upsertMaterial({
    sourceId: X_SOURCE, url: `https://x.com/test/status/1${Date.now()}`, title: text, via: "fetch", publishedAt: new Date(),
    xPost: { tweetId: `1${Date.now()}`, authorName: "测试", handle: "test", text },
  });
  const post = await analyzeArticle(articleId);
  assert.deepEqual([post!.output!.titleZh, post!.output!.summaryZh], [text, text]);
  assert.ok(!calls("推文").includes("summarize"), "no translation call");
  const sensitive = await analyzeArticle(await article("SENSITIVE"));
  assert.deepEqual([sensitive!.output!.selected, sensitive!.output!.titleZh], [true, "翻译标题 SENSITIVE"]);
  assert.deepEqual(calls("SENSITIVE").filter((s) => s === "understand" || s === "summarize"), ["understand", "summarize"]);
});

test("guards: a company the input does not name is not written in; long summaries are cut at sentences", () => {
  const input = { title: "某实验室发布新模型", text: "某实验室发布了一个新模型，参数规模和价格都有说明。", sourceKind: "rss" };
  const guarded = enforceIdentity(input, { titleZh: "OpenAI 发布新模型", summaryZh: "某实验室发布新模型。" });
  assert.deepEqual([guarded.titleZh, guarded.summaryZh, guarded.identityGuard.outcome], ["某实验室发布新模型", "某实验室发布新模型。", "fallback"]);
  // The identity lexicon: a Chinese rendering of a company the input names in English is no invention.
  const alibaba = { title: "Alibaba ships a new coding model", text: "Alibaba released a coding model with pricing details.", sourceKind: "rss" };
  assert.equal(enforceIdentity(alibaba, { titleZh: "阿里巴巴发布编程模型", summaryZh: "阿里巴巴发布了编程模型并公布价格。" }).identityGuard.outcome, "pass");
  // The title's company against the fact's: a subject the vocabulary does not list as a name is read by the lexicon; one with two companies is not checked.
  assert.deepEqual(subjectGuard("Google DeepMind 团队", "DeepMind 公布新的蛋白质研究"), { outcome: "match", factEntity: "google", titleEntities: ["google"] });
  assert.equal(subjectGuard("OpenAI 与微软", "OpenAI 发布新模型").outcome, "unknown");
  const long = "第一句交代了谁做了什么以及关键结果，这一句本身已经足够说明核心事件的来龙去脉。".repeat(3) + "第二句补充数字。".repeat(20);
  assert.ok(compactAnswerFirstSummary(long).length <= 190);
  // A short first sentence and a long second one: the card once ended "…可连接 Google Ads 和 Meta 账号在 Google。".
  const lovable = "Lovable 推出增长工具，在原有建应用聊天窗口中提供增长计划、广告投放和 SEO 能力。用户设定目标后，Lovable 依据应用上下文生成可执行计划；可连接 Google Ads 和 Meta 账号在 Google、YouTube、Facebook、Instagram 投放广告，广告上线前需用户审批，计费直接走 Google Ads 和 Meta 账号，Lovable 不加收服务费；SEO 方面覆盖索引基础、内置 Semrush 关键词机会分析和站外社区推广建议。功能现已在 Free、Pro 和 Business 计划可用。";
  assert.equal(compactAnswerFirstSummary(lovable), "Lovable 推出增长工具，在原有建应用聊天窗口中提供增长计划、广告投放和 SEO 能力。", "whole sentences, never half of one");
  // Only a first sentence longer than the limit is cut, at a clause, never inside an enumeration.
  const runOn = "某实验室发布新模型，支持" + "甲乙丙、".repeat(39) + "甲乙丙，" + "补充说明".repeat(20) + "。";
  const head = compactAnswerFirstSummary(runOn).slice(0, -1);
  assert.ok(runOn.startsWith(head) && "，；".includes(runOn[head.length]!), head);
  assert.deepEqual(parseTranslateOutput("title_zh: 标题\nsummary_zh: 第一句。\n第二句。"), { titleZh: "标题", summaryZh: "第一句。\n第二句。", bodyZh: "" });
  assert.equal(parseTranslateOutput("title_zh: 标题\nbody_zh: 我们懂你。\n\n来源：X：PixVerse (@PixVerse)").bodyZh, "我们懂你。", "a repeated prompt line is dropped");
});

test("a source class raises its tier's threshold to the class floor and never lowers one", () => {
  assert.ok(CLASS && CLASS_FLOOR - 1 >= T1, "the cases need a pack class whose floor lies above the official threshold and below the media one");
  assert.equal(selectionThreshold({ tier: "T1", selectionClass: null }), T1);
  assert.equal(selectionThreshold({ tier: "T1", selectionClass: CLASS }), CLASS_FLOOR);
  assert.equal(selectionThreshold({ tier: "T2", selectionClass: CLASS }), T2, "a media source keeps its own, higher threshold");
  assert.equal(selectionThreshold({ tier: "EXCLUDE_MP", selectionClass: CLASS }), null, "a tier without a threshold stays out of 精选");
});

test("after the admin gives a source a class, analysing again holds the paid scores against the class floor", async () => {
  // Scores that select from an ordinary official source and stay under the class floor.
  const id = await article("ECOSYS", { sourceId: CLASSED_SOURCE });
  const first = await analyzeArticle(id);
  assert.deepEqual([first!.output!.selected, (await row(id)).output.threshold], [true, T1]);
  const version = async () => (await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${CLASSED_SOURCE}`)[0]!.updated_at.toISOString();
  await assert.rejects(updateSource(CLASSED_SOURCE, { patch: { selection_class: "not-a-class" }, version: await version() }, "test"), "only the pack's classes");
  await updateSource(CLASSED_SOURCE, { patch: { selection_class: CLASS }, version: await version(), reason: "test" }, "test");
  const hits = provider.hits();
  const again = await analyzeArticle(id);
  // The same paid answers (the class is not part of any model input); the second score is asked now only if
  // the first decided alone against the lower threshold, and lies near the class floor.
  assert.equal(provider.hits() - hits, needsSecondScore(CLASS_FLOOR, T1) ? 0 : 1);
  assert.deepEqual([again!.output!.selected, again!.output!.score, (await row(id)).output.threshold], [false, CLASS_FLOOR - 1, CLASS_FLOOR]);
  const created = await createSource({ id: `test-classed-new-${T}`, name: "Created with a class", kind: "rss", config: { feedUrl: `https://example.com/feed-${T}.xml` }, tier: "T1", selection_class: CLASS }, "test");
  assert.equal(created.created && created.source.selection_class, CLASS, "a new source can start with a class");
});

test("analysing the same revision again reuses every paid answer", async () => {
  scoreAnswers.CLEAR = [T1 + 2, T1];
  const id = await article("CLEAR", { url: `https://example.com/CLEAR-again-${T}`, title: `CLEAR model release again ${T}` });
  const first = await analyzeArticle(id);
  assert.equal(first!.reused, false);
  const hits = provider.hits();
  const again = await analyzeArticle(id);
  assert.equal(provider.hits(), hits, "no new requests");
  assert.deepEqual([again!.reused, again!.receiptIds], [true, first!.receiptIds]);
});

// Reprints (editorial/copies.ts). Each original has a text of its own: random words, without LONG, whose
// eight repeats outweigh anything beside them and bring every other fixture article within a few bits. So
// no case finds another's original; its reprint differs only in what the fingerprint leaves out (spacing, a link).
const words = () => Array.from({ length: 40 }, () => Math.random().toString(36).slice(2, 8)).join(" ");
async function original(marker: "REPRINT" | "UNWANTED", sourceId = SOURCE, bodyText = `${marker}: ${words()} ${words()}`) {
  const title = `${marker} model release ${tag()}`;
  const id = await article(marker, { sourceId, url: `https://example.com/original-${tag()}`, title, bodyText });
  await analyzeArticle(id);
  return { id, title, bodyText };
}
const grouped = (id: string) => sql`UPDATE articles SET grouping_status = 'complete' WHERE id = ${id}`;
const reprint = async (of: { title: string; bodyText: string }, sourceId = REPRINTER) => (await upsertMaterial({
  sourceId, url: `https://example.org/reprint-${tag()}`, title: of.title, bodyText: `${of.bodyText.replaceAll(" ", "  ")}\n\nhttps://example.org/from-${tag()}`,
  bodyStatus: "ok", via: "fetch", publishedAt: new Date("2026-09-28T01:02:03Z"),
})).articleId;
/** Processes the article; true when it was judged in full: some model call, and a judgement that names no original. */
const judgedInFull = async (id: string, opts: { attemptTag?: string } = {}) => {
  const hits = provider.hits();
  await processArticle(id, opts);
  return provider.hits() > hits && (await row(id)).output.copyOf === undefined;
};

test("a reprint from another source takes the original's judgement without a model call, a block as well", async () => {
  const passed = await original("REPRINT");
  await grouped(passed.id);
  const copy = await reprint(passed);
  const hits = provider.hits();
  assert.equal((await processArticle(copy)).state, "pass");
  assert.equal(provider.hits(), hits, "no model call");
  const [mine, theirs] = [await row(copy), await row(passed.id)];
  assert.deepEqual([mine.relevance, mine.title_zh, mine.category, mine.tags, mine.output.fact], [theirs.relevance, theirs.title_zh, theirs.category, theirs.tags, theirs.output.fact]);
  assert.deepEqual([theirs.selected, mine.selected, mine.receipt_ids], [true, false, []], "a copy is never selected on its own");
  assert.deepEqual([mine.output.copyOf, mine.output.distance], [passed.id, 0]);
  const [p] = await sql`SELECT eligible, selected FROM publications WHERE article_id = ${copy}`;
  assert.deepEqual({ ...p }, { eligible: false, selected: false }, "its original stands for it in the pool");

  const blocked = await original("UNWANTED");
  const blockedCopy = await reprint(blocked);
  const before = provider.hits();
  assert.equal((await processArticle(blockedCopy)).state, "block", "a blocked original has no grouping to wait for");
  assert.equal(provider.hits(), before);
  assert.equal((await row(blockedCopy)).output.copyOf, blocked.id);
});

test("a reprint of an original that is still being grouped waits for it", async () => {
  const o = await original("REPRINT");
  const copy = await reprint(o);
  const hits = provider.hits();
  assert.equal((await processArticle(copy)).state, "waiting-original");
  const [waiting] = await sql`SELECT processing_state, processing_retry_at > now() + interval '4 minutes' AS later FROM articles WHERE id = ${copy}`;
  assert.deepEqual({ ...waiting }, { processing_state: "new", later: true }, "the sweep looks again in a few minutes");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${copy}`).length, 0);
  await grouped(o.id);
  assert.equal((await processArticle(copy)).state, "pass");
  assert.equal(provider.hits(), hits);
  assert.equal((await row(copy)).output.copyOf, o.id);
});

test("only a source held to the same line or a higher one copies; the same source, a short text and a re-evaluation are judged in full", async () => {
  const media = await original("REPRINT", REPRINTER);
  await grouped(media.id);
  assert.ok(await judgedInFull(await reprint(media, OFFICIAL)), "a first-party post is never a copy of a media article held to a higher threshold");

  const official = await original("REPRINT");
  await grouped(official.id);
  const peer = await reprint(official, OFFICIAL);
  await processArticle(peer);
  assert.equal((await row(peer)).output.copyOf, official.id, "a source held to the same threshold copies");
  assert.ok(await judgedInFull(await reprint(official, SOURCE)), "the same source");
  assert.ok(await judgedInFull(await reprint(official), { attemptTag: `admin:${tag()}` }), "an explicit re-evaluation");

  const short = await original("REPRINT", SOURCE, `REPRINT: ${words().slice(0, 100)}`);
  await grouped(short.id);
  assert.ok(await judgedInFull(await reprint(short)), "too short to tell a reprint from a coincidence");
});

test("an original an editor withdraws or corrects after it was found is not copied: the reprint is judged in full", async () => {
  for (const moderate of [
    async (id: string) => { await publishArticle(id); await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`; },
    (id: string) => sql`INSERT INTO editorial_overrides (article_id, fields, reason, version, updated_by) VALUES (${id}, '{"title":"更正"}', '更正', 1, 'test')`,
  ]) {
    const o = await original("REPRINT");
    await grouped(o.id);
    const copy = await reprint(o);
    const input = (await loadAnalyzeInput(copy))!;
    const h = fingerprint(copyText(input))!;
    const found = (await findOriginal(h, input))!;
    assert.equal(found.id, o.id);
    await moderate(o.id);
    assert.equal(await commitCopy(input, found, h), null);
    assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${copy}`).length, 0, "nothing of the original's judgement is written");
    assert.ok(await judgedInFull(copy));
  }
});
