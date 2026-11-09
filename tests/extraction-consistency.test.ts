// Failure cases: two workers finish the same extraction; a report revises the article while a page
// or X Article is in flight; an obsolete empty response marks new input unconfirmed; an admin
// repeats extraction of unchanged HTML. Neither content nor revision history may go backwards.
// A page Readability finds no article in, or one only a browser renders, is read for free before Jina.
import { gate, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody, extractFromUrl, pageRules } from "@aihot/backend/content/extract";
import { renderPage } from "@aihot/backend/providers/render";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { queueProcessing, registerExtractionJobs } from "@aihot/backend/jobs/content";
import { rerun } from "@aihot/backend/admin/content";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import { fetchJsonList } from "@aihot/backend/sources/json-list";

const sourceId = `extract-consistency-${tag()}`;
const body = "This is the original article, with enough substantive text to extract its paragraphs. ".repeat(12);
let presentationHtml: string | null = null;
let rssHtml = "";
let hold: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>>; count: number; empty: boolean; failed?: boolean };
const page = http.createServer(async (_req, res) => {
  if (_req.url === "/commit/abc?lang=en") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<html><head><title>Commit title</title></head><body><article><h1>Commit title</h1><p>${body}</p></article></body></html>`);
  }
  if (_req.url === "/commits.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify([{ id: "abc", title: "Commit title", summary: body }]));
  }
  if (_req.url === "/commit/abc.patch?lang=en") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end("diff --git a/README.md b/README.md\n-Old offer ended\n+New free model credits <100>\n" + body);
  }
  if (_req.url === "/feed") {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    return res.end(`<rss version="2.0"><channel><title>Feed</title><item><title>RSS original</title><link>${base}/rss-original</link><content:encoded><![CDATA[${rssHtml}]]></content:encoded></item></channel></rss>`);
  }
  // A client-rendered page: the article only in its structured data, or nowhere before a browser runs it.
  if (_req.url === "/declared" || _req.url === "/shell") {
    res.writeHead(200, { "content-type": "text/html" });
    const data = _req.url === "/declared" ? `<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline: "Declared", articleBody: body.trim() })}</script>` : "";
    return res.end(`<html><head><title>Declared</title>${data}</head><body><div id="root"><p>Loading…</p></div><noscript>Enable JavaScript to read this article.</noscript></body></html>`);
  }
  if (--hold.count === 0) hold.entered.open();
  await hold.release.promise;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(hold.empty ? "<html><body>Empty</body></html>" : `<html><head><title>Original</title></head><body><article><h1>Original</h1>${presentationHtml ?? `<p>${body}</p>`}</article></body></html>`);
});
await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
const socialdata = await stub(async () => {
  hold.entered.open();
  await hold.release.promise;
  if (hold.failed) return new Reply(503, { error: "Temporary extraction failure" });
  return hold.empty ? {} : { article: { title: "Old X Article", content_state: { blocks: [{ text: body }] } } };
});
// The self-hosted renderer (Crawl4AI's /crawl): every request is kept, the answer is the page as rendered.
const renders: Array<{ path?: string; authorization?: string; urls: string[] }> = [];
let rendered: Record<string, unknown> = {};
const renderer = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const { urls } = JSON.parse(Buffer.concat(chunks).toString());
    renders.push({ path: req.url, authorization: req.headers.authorization, urls });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, results: [{ url: urls[0], success: true, status_code: 200,
      html: `<html><head><title>Rendered</title></head><body><article><h1>Rendered</h1><p>${body}</p></article></body></html>`, ...rendered }] }));
  });
});
await new Promise<void>(resolve => renderer.listen(0, "127.0.0.1", resolve));
process.env.SOCIALDATA_API_KEY = "test-key";
process.env.SOCIALDATA_BASE_URL = socialdata.url;
process.env.JINA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;
before(async () => {
  await sql`INSERT INTO sources(id,name,kind) VALUES (${sourceId},'Extraction consistency','rss')`;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000 WHERE service='socialdata'`;
  // Jina stopped: a page without a readable body stays without one.
  await sql`UPDATE budgets SET per_minute=0,per_hour=0,per_day=0 WHERE service='jina'`;
});
after(async () => { page.close(); renderer.close(); await socialdata.close(); await stopBoss(); await closeDb(); });
const reset = (count = 1, empty = false) => { presentationHtml = null; hold = { entered: gate(), release: gate(), count, empty }; };
const state = async (id: string) => ({ ...(await sql`SELECT title,body_text,body_status,revision,content_hash FROM articles WHERE id=${id}`)[0] });

test("a source can read a text alternate without losing patch lines or mistaking markup for HTML", async () => {
  const source = { config: { url: `${base}/commits.json`, titlePaths: ['title'], summaryPaths: ['summary'], summaryIsBody: true,
    urlTemplate: `${base}/commit/{id}?lang=en`, detail: { bodyUrlSuffix: '.patch', titleSelector: 'h1' } } } as never;
  const [candidate] = await fetchJsonList(source);
  assert.equal(candidate!.bodyStatus, 'pending', 'a JSON summary is not the explicit body alternate');
  const detail = await fetchDetail(candidate!.url, source, { date: false, title: true, summary: false, body: true });
  assert.equal(detail.title, 'Commit title');
  assert.equal(detail.body, null, 'metadata extraction must leave the alternate body for extraction');
  const got = await extractFromUrl(`${base}/commit/abc?lang=en`, "test-patch", pageRules({ detail: { bodyUrlSuffix: ".patch" } }), { paidFallback: false });
  assert.ok(got);
  assert.match(got.text, /\n-Old offer ended\n\+New free model credits <100>/);
  assert.match(got.html, /&lt;100&gt;/);
});

test("an article only Defuddle finds is the same free body in a detail read and in extraction", async () => {
  const got = await extractFromUrl(`${base}/declared`, "test-declared", {}, { paidFallback: false });
  assert.equal(got?.via, "defuddle", "Readability finds no article in the page");
  assert.equal(got.text, body.trim());
  const detail = await fetchDetail(`${base}/declared`, { id: sourceId, config: {} } as never, { date: true, title: false, summary: false, body: true });
  assert.deepEqual(detail.body, got);
  assert.equal(await extractFromUrl(`${base}/shell`, "test-shell", {}, { paidFallback: false }), null, "a page without the article has no body, not its placeholder text");
});

test("a page only a browser renders goes to the self-hosted renderer before Jina, never with a private address", async () => {
  process.env.RENDER_URL = `http://127.0.0.1:${(renderer.address() as { port: number }).port}`;
  process.env.RENDER_TOKEN = "render-token";
  try {
    assert.equal(await extractFromUrl(`${base}/shell`, "test-render", {}, { paidFallback: false }), null);
    assert.equal(renders.length, 0, "a caller that wants only the page as fetched skips the renderer");
    // Jina is stopped in this file, so a body here is the renderer's.
    const got = await extractFromUrl(`${base}/shell`, "test-render", {});
    assert.equal(got?.via, "render");
    assert.ok(got.text.includes(body.trim()));
    assert.deepEqual(renders, [{ path: "/crawl", authorization: "Bearer render-token", urls: [`${base}/shell`] }]);
    config.allowPrivateNetworkFetch = false;
    try {
      assert.equal(await renderPage("http://10.0.0.8/article"), null);
      assert.equal(renders.length, 1, "an address the fetcher refuses is never handed over");
      rendered = { redirected_url: "http://169.254.169.254/latest/meta-data/", redirected_status_code: 200 };
      assert.equal(await renderPage("http://203.0.114.10/article"), null, "nor is a page read that ended on one");
      assert.equal(renders.length, 2);
    } finally { config.allowPrivateNetworkFetch = true; rendered = {}; }
    rendered = { html: `<html><body><article>${"x".repeat(9 * 1024 * 1024)}</article></body></html>` };
    assert.equal(await renderPage(`${base}/shell`), null, "a page past the direct fetch's size limit is not read");
    rendered = {};
    delete process.env.RENDER_TOKEN;
    const sent = renders.length;
    assert.equal(await renderPage(`${base}/shell`), null);
    assert.equal(renders.length, sent, "without a token nothing is sent to the renderer");
  } finally { delete process.env.RENDER_URL; delete process.env.RENDER_TOKEN; }
});

for (const x of [false, true]) for (const empty of [false, true]) {
  test(`a stale ${x ? "X Article" : "page"} ${empty ? "empty" : "successful"} response cannot change newer material`, async () => {
    reset(1, empty);
    const tweetId = `${Date.now()}${empty ? 2 : 1}`;
    const material = { sourceId, url: `${base}/${tag()}`, title: "Original", via: "fetch" as const,
      ...(x ? { xPost: { tweetId, authorName: "Author", handle: "author", text: "https://x.com/i/article/123" } } : {}) };
    const { articleId } = await upsertMaterial(material);
    const pending = extractArticleBody(articleId);
    await hold.entered.promise;
    let expected;
    try {
      await upsertMaterial({ ...material, title: "Corrected report", ...(empty ? {} : { bodyText: "The corrected body supplied by the publisher." }) });
      expected = await state(articleId);
    } finally { hold.release.open(); }
    const result = await pending;
    assert.deepEqual(await state(articleId), expected, "old network results must not touch the new revision or its pending status");
    assert.equal(result, "skipped");
  });
}

test("overlapping page extractions and an unchanged admin retry create only one body revision", async () => {
  reset(2);
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/${tag()}`, title: "Original", via: "fetch" });
  const pending = [extractArticleBody(articleId), extractArticleBody(articleId)];
  await hold.entered.promise;
  hold.release.open();
  await Promise.all(pending);
  const saved = await state(articleId);
  assert.equal(saved.revision, 2, "concurrent workers must not revise identical content twice");
  reset();
  hold.release.open();
  await sql`UPDATE articles SET body_status='pending' WHERE id=${articleId}`;
  assert.equal(await extractArticleBody(articleId), "ok");
  assert.deepEqual(await state(articleId), saved);
  assert.equal((await sql`SELECT 1 FROM article_revisions WHERE article_id=${articleId}`).length, 2);
});

test("an audited presentation refresh previews and applies only the reviewed layout without reprocessing", async () => {
  reset(); hold.release.open();
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/${tag()}`, title: "Original", via: "fetch" });
  await extractArticleBody(articleId);
  await sql`UPDATE articles SET processing_state='analyzed',grouping_status='complete',media='[{"kind":"image","url":"https://example.com/publisher-cover.png"}]' WHERE id=${articleId}`;
  const before = await state(articleId);
  const [counts] = await sql`SELECT (SELECT count(*)::int FROM receipts) receipts,(SELECT count(*)::int FROM article_revisions WHERE article_id=${articleId}) revisions`;
  presentationHtml = `<p>${body}</p><figure><a href="https://example.com/chart"><img src="https://example.com/chart.png" alt="chart"></a></figure>`;
  const preview = await rerun(articleId, "presentation", "preview-layout", "test", { preview: true });
  assert.ok(preview && "version" in preview);
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.images, { before: 0, after: 1 });
  assert.doesNotMatch((await sql`SELECT body_html FROM articles WHERE id=${articleId}`)[0]!.body_html, /chart.png/);
  const applied = await rerun(articleId, "presentation", "apply-layout", "test", { version: preview.version });
  assert.ok(applied && "applied" in applied && applied.applied);
  assert.match((await sql`SELECT body_html FROM articles WHERE id=${articleId}`)[0]!.body_html, /chart.png/);
  assert.equal((await sql`SELECT media->0->>'url' AS cover FROM articles WHERE id=${articleId}`)[0]!.cover, 'https://example.com/publisher-cover.png', "a page's body pictures must not replace the publisher's cover");
  assert.deepEqual(await state(articleId), before);
  assert.deepEqual({ ...(await sql`SELECT (SELECT count(*)::int FROM receipts) receipts,(SELECT count(*)::int FROM article_revisions WHERE article_id=${articleId}) revisions`)[0] }, { ...counts });
  assert.deepEqual(await rerun(articleId, "presentation", "apply-layout", "test", { version: preview.version }), applied, "the audited request is idempotent");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.rerun.presentation'`).length, 1);
  await sql`INSERT INTO translations(article_id,lang,revision,body_html,body_text,complete,origin)
    VALUES (${articleId},'zh',${before.revision},'<p>原有的<a href="https://example.com/legacy">中文</a>译文。</p>','原有的中文译文。',true,'model')`;
  const unchanged = await rerun(articleId, "presentation", "preview-unchanged", "test", { preview: true });
  assert.equal(unchanged?.changed, false);
  assert.equal(unchanged?.ready, true, "unchanged original HTML does not require reusing mismatched historical translation structure");
  presentationHtml = `<p><a href="https://example.com/new">This</a>${body.slice(4)}</p>`;
  const unsafe = await rerun(articleId, "presentation", "preview-links", "test", { preview: true });
  assert.equal(unsafe?.ready, false);
  assert.equal(unsafe?.translation, "blocked");
  assert.match(unsafe?.reason ?? "", /正常重翻/);
  presentationHtml = `<p>${body} The actual model price has changed.</p>`;
  const semantic = await rerun(articleId, "presentation", "preview-wording", "test", { preview: true });
  assert.ok(semantic && "ready" in semantic && !semantic.ready);
  assert.match(semantic.reason ?? "", /文字/);
  await assert.rejects(rerun(articleId, "presentation", "apply-wording", "test", { version: preview.version }), /预览|变化|文字/);
});

test("an audited RSS presentation refresh uses the source body without substituting the web-page wording", async () => {
  reset(); hold.release.open();
  const rssSource = `${sourceId}-rss`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES (${rssSource},'RSS presentation','rss',${sql.json({ feedUrl: `${base}/feed` })})`;
  const text = "This is the RSS edition of the article with its own subscriber wording. ".repeat(8).trim();
  const { articleId } = await upsertMaterial({ sourceId: rssSource, url: `${base}/rss-original`, title: "RSS original", via: "fetch", bodyText: text, bodyHtml: `<p>${text}</p>`, bodyStatus: 'ok' });
  rssHtml = `<p>${text}</p><figure><img src="https://example.com/rss-chart.png"></figure>`;
  const preview = await rerun(articleId, "presentation", "preview-rss-layout", "test", { preview: true });
  assert.equal(preview?.ready, true, "the page has different wording, but the feed still has the original text");
  assert.deepEqual(preview!.images, { before: 0, after: 1 });
  await rerun(articleId, "presentation", "apply-rss-layout", "test", { version: preview!.version });
  const [stored] = await sql`SELECT body_html,body_text,revision FROM articles WHERE id=${articleId}`;
  assert.equal(stored!.body_text, text);
  assert.equal(stored!.revision, 1);
  assert.match(stored!.body_html, /rss-chart/);
});

// The worker's error path is also a write: a late provider error must not add retry state to a
// newer, complete report. Exercise pg-boss's actual callback rather than only the extractor.
test("an obsolete extraction failure cannot penalize a newer complete report", async () => {
  reset();
  hold.failed = true;
  const source = `${sourceId}-worker`;
  await sql`INSERT INTO sources(id,name,kind) VALUES (${source},'Extraction worker','x_search')`;
  const material = { sourceId: source, url: `https://x.com/author/status/${Date.now()}`, title: "Original", via: "fetch" as const,
    xPost: { tweetId: `${Date.now()}9`, authorName: "Author", handle: "author", text: "https://x.com/i/article/123" } };
  const { articleId } = await upsertMaterial(material);
  const job = await queueProcessing(articleId);
  await registerExtractionJobs(await getBoss());
  await hold.entered.promise;
  try { await upsertMaterial({ ...material, title: "Corrected", bodyText: "Complete corrected body" }); }
  finally { hold.release.open(); }
  const deadline = Date.now() + 12_000;
  while ((await sql`SELECT state FROM pgboss.job WHERE id=${job!}`)[0]?.state !== "completed") {
    assert.ok(Date.now() < deadline, "extraction worker did not finish");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const [row] = await sql`SELECT body_status,processing_attempts,processing_error,processing_retry_at FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...row }, { body_status: "ok", processing_attempts: 0, processing_error: null, processing_retry_at: null });
});
