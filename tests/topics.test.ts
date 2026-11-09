// Topic pages: which articles a topic takes, and their counts.
// Written before the code, from the ways it can go wrong:
// - a company topic takes an article about another company that only mentions it (several subjects,
//   its name nowhere in the title), or drops one about it whose title names it in English, in another
//   case, next to Chinese text, or only by a product (it is the article's only subject);
// - a Latin name matches inside another word ("Metadata" is not Meta); a headline naming a company
//   that is not a subject of the article gets in;
// - a technical-direction topic stops taking its tags;
// - withdrawn or not yet released articles appear in a list or a count;
// - an article or story page names a topic its reports do not belong to;
// - an article page cannot tell which of its tags are a topic's own, so they link to filtered lists;
// - a topic without content has no page, or an unknown slug or a page past the end has one;
// - 上升中 counts a story twice for two of its reports, counts withdrawn reports, signal-only posts or
//   days outside the 28 before, judges by raw counts instead of the day's share, keeps an old breakout
//   after the trends stopped, or a weekly lists a topic that did not break out in its week.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { computeTopicTrends } from "@aihot/backend/events/trends";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadReport } from "@aihot/backend/publication/reports";
import { TOPICS, loadTopicPage, listTopicSummaries, topicsOfStory } from "@aihot/backend/publication/topics";
import { composeWeekly } from "@aihot/backend/reports/compose";
import { addDays, beijingAt, isoWeekRange } from "@aihot/contracts/time";
import { TOPIC_RISING } from "@aihot/industry/taxonomy";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const OFFICIAL = `test-topics-official-${T}`;
const MEDIA = `test-topics-media-${T}`;
const SIGNAL = `test-topics-signal-${T}`;
const app = await buildApp();
// The weekly's overview writer; what it writes does not matter here.
const writer = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ overview: "", sections: {} }) } }] }));
process.env.DEEPSEEK_BASE_URL = `${writer.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at) VALUES
    (${OFFICIAL}, 'Official', 'rss', 'T1', 'editorial', true, '2100-01-01'),
    (${MEDIA}, 'Media', 'rss', 'T2', 'editorial', false, '2100-01-01'),
    (${SIGNAL}, 'Signal', 'rss', 'T2', 'hot_signal', false, '2100-01-01')`;
});
after(async () => {
  await app.close();
  await writer.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
interface Report {
  source?: string;
  at: Date;
  title: string;
  originalTitle?: string;
  subjects?: string[];
  tags?: string[];
  score?: number;
  selected?: boolean;
  fact?: number;
  category?: string;
}

/** A published report; `fact` links it to a fact before publishing, as grouping would. */
async function report(r: Report): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: r.source ?? MEDIA, url: `https://example.com/topics-${T}-${n}`, title: r.originalTitle ?? r.title, bodyText: "body", bodyHtml: "<p>body</p>", bodyStatus: "ok", via: "fetch", publishedAt: r.at,
  });
  await sql`UPDATE articles SET discovered_at = ${r.at}, timeline_at = ${r.at}, grouped_at = now() WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, subjects, tags)
            VALUES (${articleId}, 1, 'rule', 'pass', ${r.category ?? "ai-models"}, ${r.title}, ${`摘要 ${n}`}, ${r.score ?? 80}, ${r.selected ?? true}, ${r.subjects ?? []}, ${[r.category === "ai-products" ? "产品更新" : r.category === "paper" ? "论文/研究" : r.category === "tip" ? "教程/实践" : r.category === "industry" ? "行业动态" : r.category === "opinion" ? "大佬观点" : "模型发布", ...(r.tags ?? [])]})`;
  if (r.fact) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${r.fact}, ${articleId}, 'report')`;
  await publishArticle(articleId, { releasedAt: new Date(r.at.getTime() + 60_000) });
  return articleId;
}

async function story(title: string): Promise<{ id: number; publicId: string }> {
  const publicId = randomUUID();
  const [s] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${title}, now(), now()) RETURNING id`;
  return { id: s!.id, publicId };
}

async function fact(storyId: number | null, title: string): Promise<number> {
  const [f] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}-${randomUUID()}`}, ${storyId}, ${title}) RETURNING id`;
  return f!.id;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);
const page = async (slug: string, p = 1) => {
  const data = await loadTopicPage(slug, p, new Date());
  assert.ok(data, `${slug} page ${p}`);
  return data;
};
/** Every article of a topic, over all its pages. */
async function members(slug: string): Promise<string[]> {
  const first = await page(slug);
  const out = ids(first.items);
  for (let p = 2; p <= first.pageCount; p++) out.push(...ids((await page(slug, p)).items));
  return out;
}

test("a company topic takes the articles about it, not the ones that only mention it", async () => {
  const about = await report({ at: hoursAgo(30), title: `Claude Code 推出插件 ${T}`, subjects: ["anthropic"] });
  const product = await report({ at: hoursAgo(31), title: `Sonnet 新版上线 ${T}`, subjects: ["anthropic"] });
  const english = await report({ at: hoursAgo(32), title: `新模型发布 ${T}`, originalTitle: `Anthropic launches a model ${T}`, subjects: ["anthropic", "openai"] });
  const subpoena = await report({ at: hoursAgo(33), title: `加州检察长向 OpenAI 发出传票 ${T}`, subjects: ["openai", "anthropic", "hugging-face"] });
  const lowerCase = await report({ at: hoursAgo(34), title: `openai 公布新的安全框架 ${T}`, subjects: ["openai", "anthropic"] });
  const pact = await report({ at: hoursAgo(35), title: `二十余家科技公司签署安全协议 ${T}`, subjects: ["openai", "anthropic", "google"] });
  const metadata = await report({ at: hoursAgo(36), title: `Metadata 标准发布，OpenAI 参与 ${T}`, subjects: ["meta", "openai"] });
  const adjacent = await report({ at: hoursAgo(37), title: `发布Meta的新模型 ${T}`, subjects: ["meta", "openai"] });
  const headline = await report({ at: hoursAgo(38), title: `Anthropic 被一篇盘点提到 ${T}`, subjects: ["google"] });
  const agent = await report({ at: hoursAgo(39), title: `智能体框架发布 ${T}`, tags: ["Agent"] });

  const anthropic = await members("anthropic");
  for (const id of [about, product, english]) assert.ok(anthropic.includes(id), "about Anthropic");
  for (const id of [subpoena, lowerCase, pact, headline]) assert.ok(!anthropic.includes(id), "only mentions Anthropic");
  const openai = await members("openai");
  for (const id of [subpoena, lowerCase, metadata]) assert.ok(openai.includes(id), "about OpenAI");
  for (const id of [english, pact]) assert.ok(!openai.includes(id), "only mentions OpenAI");
  const meta = await members("meta");
  assert.ok(meta.includes(adjacent), "Meta next to Chinese text");
  assert.ok(!meta.includes(metadata), "Metadata is not Meta");
  assert.ok((await members("agent")).includes(agent), "a technical direction takes its tag");

  // The article page names the topics it belongs to.
  const topicsOf = async (id: string) => {
    const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
    return (JSON.parse(res.body) as { topics: Array<{ slug: string }> }).topics.map((t) => t.slug);
  };
  assert.deepEqual(await topicsOf(about), ["anthropic", "model-releases"]);
  assert.deepEqual(await topicsOf(subpoena), ["openai", "model-releases"]);
  assert.deepEqual(await topicsOf(pact), ["model-releases"]);
  assert.deepEqual(await topicsOf(agent), ["agent", "model-releases"]);
});

test("an article page says which of its tags are a topic's own", async () => {
  // A direction's or a form's tags, and the tag cards show for a company (its subject tag is never shown).
  const id = await report({ at: hoursAgo(3), title: `Anthropic 开源智能体框架 ${T}`, subjects: ["anthropic", "openai"], tags: ["Agent", "开源/仓库", "Anthropic", "OpenAI", "框架"] });
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
  const body = JSON.parse(res.body) as { tags: string[]; tagTopics: Record<string, string>; topics: Array<{ slug: string }> };
  assert.deepEqual(body.tags, ["模型发布", "Agent", "开源/仓库", "Anthropic", "OpenAI", "框架"]);
  assert.deepEqual(body.tagTopics, { "模型发布": "model-releases", Agent: "agent", "开源/仓库": "open-source", Anthropic: "anthropic", OpenAI: "openai" });
  // The company its title does not name is a topic of the tag, not of the article.
  assert.deepEqual(body.topics.map((t) => t.slug), ["anthropic", "agent", "open-source", "model-releases"]);
});

test("renaming a company topic keeps its old full name usable for search", async () => {
  const id = await report({at: hoursAgo(2), title: `Kimi 新模型上线 ${T}`, subjects: ['kimi'], selected: false});
  for (const query of ['Kimi / 月之暗面', '月之暗面 / Kimi']) {
    const res = await app.inject({method: 'GET', url: `/api/site/pool?q=${encodeURIComponent(query)}`});
    assert.equal(res.statusCode, 200);
    assert.ok(ids(JSON.parse(res.body).items).includes(id), 'full company names must still find subject-tagged reports');
  }
});

test("a story page names the topics of its reports", async () => {
  const launch = await story(`智能体框架 V2 发布 ${T}`);
  await report({ source: OFFICIAL, at: hoursAgo(26), title: `智能体框架 V2 发布 ${T}`, tags: ["Agent"], fact: await fact(launch.id, "发布 V2") });
  assert.deepEqual(await topicsOfStory(launch.id), [{ slug: "agent", name: "Agent 智能体" }, { slug: "model-releases", name: "模型发布" }]);
});

test("withdrawn articles stay out of lists and counts", async () => {
  const kept = await report({ at: hoursAgo(5), title: `Kimi 发布新模型 ${T}`, subjects: ["kimi"] });
  const withdrawn = await report({ at: hoursAgo(4), title: `Kimi 撤回的消息 ${T}`, subjects: ["kimi"] });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${withdrawn}`;

  const data = await page("kimi");
  assert.deepEqual(ids(data.items), [kept]);
  assert.equal(data.topic.total, 1);
  const summary = (await listTopicSummaries()).topics.find((t) => t.slug === "kimi")!;
  assert.equal(summary.latest?.title, `Kimi 发布新模型 ${T}`, "the index shows the newest public article");
});

test("every topic has a page; unknown topics and pages past the end have none", async () => {
  const empty = await page("cursor");
  assert.equal(empty.topic.indexable, false, "a topic without content is not indexed");
  assert.deepEqual(empty.items, []);
  assert.equal(await loadTopicPage("not-a-topic", 1, new Date()), null);
  assert.equal(await loadTopicPage("cursor", 2, new Date()), null);
  const index = await app.inject({ method: "GET", url: "/api/site/topics" });
  const body = JSON.parse(index.body) as { groups: Array<{ key: string }>; topics: Array<{ slug: string }> };
  assert.deepEqual(body.groups.map((g) => g.key), ["company", "field", "genre"]);
  assert.deepEqual(body.topics.map((t) => t.slug).sort(), TOPICS.map((t) => t.slug).sort(), "the index lists every topic");
});

// 上升中: each topic's stories per Beijing day against its usual share of all stories (events/trends.ts),
// with the cut-off of industry/taxonomy.ts read as it stands.
const { minStories: K, ratio: R } = TOPIC_RISING;

/** A report `source` made at noon (Beijing) on `day` in a story, as grouping leaves it: its fact, membership and signal. */
async function signal(storyId: number, day: string, tags: string[], opts: { source?: string; withdrawn?: boolean } = {}) {
  n += 1;
  const id = `topics-${T}-s${n}`;
  const at = beijingAt(day, "12:00");
  const source = opts.source ?? MEDIA;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
            VALUES (${id}, ${source}, ${id}, ${`https://example.org/${id}`}, ${id}, ${at}, ${at})`;
  const [a] = await sql`INSERT INTO analyses (article_id, input_revision, origin, output) VALUES (${id}, 1, 'rule', ${sql.json({ scope: "single" })}) RETURNING id`;
  await sql`INSERT INTO publications (article_id, analysis_id, visibility, eligible, title, tags, source_id, channel, url, discovered_at, timeline_at, sort_at)
            VALUES (${id}, ${a!.id}, ${opts.withdrawn ? "withdrawn" : "public"}, true, ${id}, ${tags}, ${source}, 'news', ${`https://example.org/${id}`}, ${at}, ${at}, ${at})`;
  const [f] = await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${id}, ${storyId}, ${id}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${f!.id}, ${id}, 'report')`;
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
            VALUES (${storyId}, ${id}, ${`source:${source}`}, ${source}, 'editorial', ${at})`;
  return id;
}

/** `agent` stories about agents and `others` about no topic, each with one report on `day`. */
async function storiesOn(day: string, agent: number, others: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < agent + others; i++) ids.push(await signal((await story(`${day} ${i}`)).id, day, i < agent ? ["Agent"] : []));
  return ids;
}

test("a topic is 上升中 when its share of a day's stories is several times its usual share", async () => {
  const day = "2099-04-29";
  // A usual day carries M stories, one about agents; the day itself K about agents and as many others,
  // so its share is M/2 times the usual one, at least the cut-off.
  const M = Math.ceil(2 * R);
  for (const before of [1, 10, 28]) await storiesOn(addDays(day, -before), 1, M - 1);
  await storiesOn(addDays(day, -29), 1, 0); // outside the 28 days: it would raise the usual share
  const [first] = await storiesOn(day, K, K);
  // None of these changes the day: a second report of a story, a withdrawn report, a post only counted as heat.
  const [{ story_id: firstStory }] = await sql<{ story_id: number }[]>`SELECT story_id FROM story_signals WHERE article_id = ${first!}`;
  await signal(firstStory!, day, ["Agent"], { source: OFFICIAL });
  await signal((await story("withdrawn")).id, day, ["Agent"], { withdrawn: true });
  await signal((await story("heat only")).id, day, ["Agent"], { source: SIGNAL });

  const at = beijingAt(addDays(day, 1), "00:20");
  await computeTopicTrends(at);
  const row = async () => (await sql<{ stories: number; baseline: number; ratio: number }[]>`SELECT stories, baseline, ratio FROM topic_trends WHERE topic = 'agent' AND day = ${day}`)[0]!;
  const counted = await row();
  assert.equal(counted.stories, K);
  assert.ok(Math.abs(counted.baseline - 1 / M) < 1e-9, `usual share ${counted.baseline}`);
  assert.ok(Math.abs(counted.ratio - M / 2) < 1e-9, `ratio ${counted.ratio}`);

  const rising = async (slug: string, now: Date) => (await loadTopicPage(slug, 1, now))!.topic.rising;
  assert.deepEqual(await rising("agent", at), { day, stories: K, ratio: Math.round((M / 2) * 10) / 10 });
  assert.equal(await rising("coding", at), null);
  assert.equal(await rising("agent", beijingAt(addDays(day, 4), "09:00")), null, "trends that stopped show no old breakout");

  // Both reports of a story withdrawn since: the next run counts the day again without it.
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id IN (SELECT article_id FROM story_signals WHERE story_id = ${firstStory!})`;
  await computeTopicTrends(at);
  assert.equal((await row()).stories, K - 1);
  assert.equal(await rising("agent", at), null, "fewer stories than the cut-off is not 上升中");
});

test("a weekly lists the topics that broke out in its week, each on its strongest day", async () => {
  const label = "2098-W20";
  const { start } = isoWeekRange(label)!;
  const trend = (topic: string, day: string, stories: number, ratio: number) => ({ topic, day, stories, baseline: 0.1, ratio });
  await sql`INSERT INTO topic_trends ${sql([
    trend("agent", addDays(start, 1), K, R), trend("agent", addDays(start, 3), K + 1, R + 1),
    trend("coding", addDays(start, 2), K, R / 2), // a usual day
    trend("video", addDays(start, -1), K, R + 2), // the week before
    trend("not-a-topic", addDays(start, 2), K, R + 3), // no longer on the site
  ])}`;
  // The week has a daily carrying one report.
  const id = await signal((await story("weekly")).id, addDays(start, 2), []);
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
            VALUES ('daily', ${addDays(start, 2)}, now(), now(), ${sql.json({ sections: [{ label: "行业动态", items: [{ itemId: id, title: id }] }] })}, now())`;
  await composeWeekly(label);
  const report = await loadReport("weekly", label);
  assert.deepEqual(report?.rising, [{ slug: "agent", name: "Agent 智能体", day: addDays(start, 3), stories: K + 1, ratio: Math.round((R + 1) * 10) / 10 }]);
});
