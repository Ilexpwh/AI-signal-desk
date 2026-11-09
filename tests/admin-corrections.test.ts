import { createHmac, randomUUID } from "node:crypto";
import { config } from "@aihot/backend/config";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { createSource, updateSource } from "@aihot/backend/admin/sources";
import { contentChain, overrideFields, rerun, setSeoIndexed, setVisibility } from "@aihot/backend/admin/content";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { ADMIN } from "@aihot/site";
import { buildApp } from "../apps/api/src/app.ts";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";

const T = tag();
const sourceId = `admin-${T}`;
await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${sourceId}, 'Admin review', 'rss', 'T1')`;
const app = await buildApp();
// The engine's admin API, which a site without admin pages does not mount.
if (!ADMIN) registerAdmin(app);
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

async function article() {
  return (await upsertMaterial({ sourceId, url: `https://example.com/${tag()}`, title: "审查材料", bodyText: "正文", bodyStatus: "ok", via: "fetch", publishedAt: new Date() })).articleId;
}

test("concurrent source intake creates one source for the same feed", async () => {
  const blocker = await sql.reserve();
  await blocker`BEGIN`;
  await blocker`LOCK TABLE sources IN SHARE MODE`;
  const pending = Promise.all(Array.from({ length: 4 }, (_, i) => createSource({
    id: `intake-${T}-${i}`, name: "Same feed", kind: "rss", config: { feedUrl: `https://example.com/feed-${T}` },
  }, "test")));
  try {
    // Hold inserts until all four requests have reached a lock: reproduce simultaneous clicks,
    // independently of how quickly the database happens to execute their duplicate checks.
    for (let i = 0; ; i++) {
      const [waiting] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (waiting!.n === 4) break;
      assert.ok(i < 200, "all concurrent requests reached the database");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await blocker`ROLLBACK`;
    blocker.release();
  }
  const results = await pending;
  assert.equal(results.filter((r) => r.created).length, 1);
  const created = results.find((r) => r.created)!;
  assert.ok(created.created);
  for (const result of results) if (!result.created) assert.equal(result.duplicate.id, created.source.id);
});

test("a source transaction rolled back at commit leaves no successful audit entry", async () => {
  await sql.unsafe(`CREATE FUNCTION refuse_admin_source_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.name = 'refuse-admin-commit' THEN RAISE EXCEPTION 'refused at commit'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE CONSTRAINT TRIGGER refuse_admin_source_commit AFTER UPDATE ON sources
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_admin_source_commit()`);
  try {
    const [before] = await sql`SELECT updated_at FROM sources WHERE id = ${sourceId}`;
    await assert.rejects(updateSource(sourceId, { patch: { name: "refuse-admin-commit" }, version: (before!.updated_at as Date).toISOString() }, "test-rollback"), /refused at commit/);
    const rows = await sql`SELECT 1 FROM audit_log WHERE actor = 'test-rollback'`;
    assert.equal(rows.length, 0);
  } finally {
    await sql.unsafe("DROP TRIGGER refuse_admin_source_commit ON sources; DROP FUNCTION refuse_admin_source_commit()");
  }
});

test("content corrections, public projection and audit either commit together or remain retryable", async () => {
  const id = await article();
  await publishArticle(id);
  await sql.unsafe(`CREATE FUNCTION refuse_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.actor = 'test-refuse-audit' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER refuse_admin_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_admin_audit()");
  try {
    for (const write of [
      () => overrideFields(id, { fields: { title: "更正标题" }, version: 0, reason: "校正" }, "test-refuse-audit"),
      () => setVisibility(id, { visibility: "withdrawn", version: 0, reason: "校正" }, "test-refuse-audit"),
    ]) {
      await assert.rejects(write(), /audit unavailable/);
      assert.equal((await sql`SELECT 1 FROM editorial_overrides WHERE article_id = ${id}`).length, 0);
      const [p] = await sql`SELECT title, visibility FROM publications WHERE article_id = ${id}`;
      assert.equal(p!.title, "审查材料");
      assert.equal(p!.visibility, "public");
    }
  } finally {
    await sql.unsafe("DROP TRIGGER refuse_admin_audit ON audit_log; DROP FUNCTION refuse_admin_audit()");
  }
  await overrideFields(id, { fields: { title: "更正标题" }, version: 0, reason: "校正" }, "test");
  await assert.rejects(setVisibility(id, { visibility: "withdrawn", version: 0, reason: "过期页面" }, "test"), { code: "conflict" });
  const [p] = await sql`SELECT title, visibility FROM publications WHERE article_id = ${id}`;
  assert.equal(p!.title, "更正标题");
  assert.equal(p!.visibility, "public");
});

test("repeating a completed command returns its job without resetting newer processing or a manual detach", async () => {
  await getBoss();
  for (const step of ["analyze", "extract", "group"] as const) {
    const id = await article();
    const key = `request-${step}-${T}`;
    const first = await rerun(id, step, key, "test");
    assert.ok(first?.jobId);
    await sql`UPDATE pgboss.job SET state = 'completed', completed_on = now() WHERE id = ${first.jobId}`;
    await sql`UPDATE articles SET processing_state = 'analyzed', revision = revision + 1 WHERE id = ${id}`;
    await sql`INSERT INTO grouping_overrides (article_id, reason, actor) VALUES (${id}, 'later manual detach', 'test')`;
    const again = await rerun(id, step, key, "test");
    assert.deepEqual(again, first);
    const [state] = await sql`SELECT processing_state FROM articles WHERE id = ${id}`;
    assert.equal(state!.processing_state, "analyzed");
    assert.equal((await sql`SELECT 1 FROM grouping_overrides WHERE article_id = ${id}`).length, 1);
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE request_id = ${key}`).length, 1);
  }
});

const reprints = `admin-reprints-${T}`;
await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${reprints}, 'Admin reprints', 'rss', 'T2')`;

/** An original and another source's copy of it, grouped together as the copy gate and joinOriginal leave them. */
async function copied() {
  const original = await article();
  const { articleId: copy } = await upsertMaterial({ sourceId: reprints, url: `https://example.org/${tag()}`, title: "审查材料", bodyText: "正文", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, summary_zh, selected, output)
            VALUES (${original}, 1, 'rule', 'pass', '原文摘要', false, '{}'), (${copy}, 1, 'rule', 'pass', '原文摘要', false, ${sql.json({ copyOf: original, distance: 2 })})`;
  await sql`UPDATE articles SET simhash = 0, processing_state = 'analyzed', processing_queued_at = NULL, grouping_status = 'complete', selection_adds_value = false WHERE id = ${copy}`;
  const [story] = await sql`INSERT INTO stories (public_id, title) VALUES (${randomUUID()}, '转载') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${randomUUID()}, ${story!.id}, '转载') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${original}, 'primary'), (${fact!.id}, ${copy}, 'report')`;
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
            VALUES (${story!.id}, ${copy}, ${`source:${reprints}`}, ${reprints}, 'editorial', now())`;
  for (const id of [original, copy]) await publishArticle(id);
  return { original, copy };
}

/** The copy has left its original's place and waits for a judgement of its own. */
async function released(copy: string, original: string) {
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${copy}`).length, 0, "its original's place is not its own judgement");
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${copy}`).length, 0);
  const [state] = await sql`SELECT grouping_status, selection_adds_value, processing_state, processing_queued_at IS NOT NULL AS queued FROM articles WHERE id = ${copy}`;
  assert.deepEqual({ ...state }, { grouping_status: "pending", selection_adds_value: null, processing_state: "new", queued: true });
  const [p] = await sql`SELECT fact_id FROM publications WHERE article_id = ${copy}`;
  assert.equal(p!.fact_id, null);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${original}`).length, 1, "the original keeps its place");
}

test("re-evaluating a copy judges it in full and groups it afresh; the chain links copy and original", async () => {
  const { original, copy } = await copied();
  const chain = (await contentChain(copy))!;
  assert.deepEqual([chain.article.copy_of, chain.article.copy_distance], [original, 2]);
  assert.deepEqual((await contentChain(original))!.copies.map((c) => [c.id, c.distance]), [[copy, 2]]);

  await getBoss();
  assert.ok((await rerun(copy, "analyze", `request-copy-${T}`, "test"))?.jobId);
  await released(copy, original);
});

// A copy took the original's judgement as it stood: once an editor withdraws or corrects the original,
// that judgement is no longer the site's, and the copy is judged again on its own.
test("withdrawing or correcting an original sends its copies back to be judged on their own", async () => {
  await getBoss();
  for (const moderate of [
    (id: string) => setVisibility(id, { visibility: "withdrawn", version: 0, reason: "撤回原文" }, "test"),
    (id: string) => overrideFields(id, { fields: { title: "更正后的原文标题" }, version: 0, reason: "更正原文" }, "test"),
  ]) {
    const { original, copy } = await copied();
    await moderate(original);
    await released(copy, original);
  }
});

test("a rejected SEO correction leaves both the decision and public indexing unchanged", async () => {
  const id = await article();
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, summary_zh, selected)
            VALUES (${id}, 1, 'rule', 'pass', '可收录的正文摘要', false)`;
  await publishArticle(id);
  const [before] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
  await sql.unsafe(`CREATE FUNCTION refuse_admin_seo_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.actor = 'test-refuse-seo' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER refuse_admin_seo_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_admin_seo_audit()");
  try {
    await assert.rejects(setSeoIndexed(id, { indexed: true, reason: "人工收录" }, "test-refuse-seo"), /audit unavailable/);
    const [after] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
    assert.deepEqual(after, before);
  } finally {
    await sql.unsafe("DROP TRIGGER refuse_admin_seo_audit ON audit_log; DROP FUNCTION refuse_admin_seo_audit()");
  }
  await setSeoIndexed(id, { indexed: true, reason: "人工收录" }, "test");
  const [indexed] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
  assert.ok(indexed!.seo_indexed_at);
  assert.equal(indexed!.seo_excluded_at, null);
  assert.equal(indexed!.indexable, true);
  await setSeoIndexed(id, { indexed: false, reason: "取消收录" }, "test");
  const [excluded] = await sql`SELECT seo_indexed_at, seo_excluded_at, indexable FROM publications WHERE article_id = ${id}`;
  assert.equal(excluded!.seo_indexed_at, null);
  assert.ok(excluded!.seo_excluded_at);
  assert.equal(excluded!.indexable, false);
});

test("bad admin input is a client error and never starts processing", async () => {
  const token = `admin-session-${T}`;
  const [user] = await sql`INSERT INTO admin_users (display_name) VALUES ('Review') RETURNING id`;
  const claims = { appId: "test-session-app", unionId: "test-session-user", email: null };
  process.env.FEISHU_LOGIN_APP_ID = claims.appId;
  process.env.FEISHU_LOGIN_APP_SECRET = "test-app-secret";
  config.adminUnionIds = [claims.unionId];
  const binding = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(["admin-session-v1", "feishu", claims])).digest("hex");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, auth_method, auth_binding, auth_claims) VALUES (${sha256(token)}, ${user!.id}, 'review-csrf', now() + interval '1 hour', 'feishu', ${binding}, ${sql.json(claims)})`;
  const headers = { cookie: `aihot_admin=${token}`, "x-csrf-token": "review-csrf", "idempotency-key": `invalid-${T}` };
  const source = await app.inject({ method: "POST", url: "/api/admin/sources", headers, payload: { id: "bad" } });
  assert.equal(source.statusCode, 400);
  const id = await article();
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${id}`;
  const response = await app.inject({ method: "POST", url: `/api/admin/content/${id}/rerun`, headers, payload: { step: "typo" } });
  assert.equal(response.statusCode, 400);
  const [state] = await sql`SELECT processing_state FROM articles WHERE id = ${id}`;
  assert.equal(state!.processing_state, "analyzed");
});
