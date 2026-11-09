// The source list shows each source's health and why it fails, failing sources first; the models page
// counts every paid request and what it cost.
import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { listSources } from "@aihot/backend/admin/sources";
import { modelsOverview } from "@aihot/backend/admin/models";

after(closeDb);

test("the source list shows health and the failure reason, failing sources first", async () => {
  await sql`INSERT INTO sources (id, name, kind, health, fail_count, last_error) VALUES
    ('list-ok', 'List A', 'rss', 'ok', 0, NULL), ('list-failing', 'List B', 'rss', 'failing', 6, 'HTTP 503')`;
  const { rows, totals } = await listSources({ q: "List" });
  assert.deepEqual(rows.map(({ id, health, fail_count, last_error }) => ({ id, health, fail_count, last_error })), [
    { id: "list-failing", health: "failing", fail_count: 6, last_error: "HTTP 503" },
    { id: "list-ok", health: "ok", fail_count: 0, last_error: null },
  ]);
  assert.equal(totals.failing, 1);
});

// The owner sets tiers from these columns: being first counts only against another source's report of the
// same fact (a scoop nobody else had says nothing about speed), and a mention, a withdrawal or a report
// older than the window counts for no one.
test("the source list shows 30 days of items, selected and how often a source was first with a fact others reported too", async () => {
  const hours = (h: number) => new Date(Date.now() - h * 3600_000);
  await sql`INSERT INTO sources (id, name, kind) VALUES ('stats-a', 'Stats A', 'rss'), ('stats-b', 'Stats B', 'rss'), ('stats-c', 'Stats C', 'rss')`;
  const fact = async () => Number((await sql`INSERT INTO facts (public_id, title) VALUES (${`stats-${randomUUID()}`}, 'stats fact') RETURNING id`)[0]!.id);
  const report = async (sourceId: string, factId: number | null, at: Date, opts: { selected?: boolean; role?: string; visibility?: string } = {}) => {
    const id = `stats-${randomUUID()}`;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, timeline_at, discovered_at, published_at)
      VALUES (${id}, ${sourceId}, ${id}, ${`https://example.org/${id}`}, ${id}, ${at}, ${at}, ${at})`;
    await sql`INSERT INTO publications (article_id, source_id, title, url, channel, timeline_at, discovered_at, published_at, sort_at, fact_id, selected, visibility)
      VALUES (${id}, ${sourceId}, ${id}, ${`https://example.org/${id}`}, 'news', ${at}, ${at}, ${at}, ${at}, ${factId}, ${opts.selected ?? false}, ${opts.visibility ?? "public"})`;
    if (factId) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${id}, ${opts.role ?? "report"})`;
  };
  const [launch, listing, own, withdrawn] = [await fact(), await fact(), await fact(), await fact()];
  await report("stats-a", launch, hours(10), { selected: true });
  await report("stats-b", launch, hours(5));
  await report("stats-c", listing, hours(40 * 24));
  await report("stats-b", listing, hours(3));
  await report("stats-a", listing, hours(20), { role: "mention" });
  await report("stats-a", own, hours(1), { selected: true });
  await report("stats-c", withdrawn, hours(30));
  await report("stats-a", withdrawn, hours(2), { selected: true, visibility: "withdrawn" });

  const { rows } = await listSources({ q: "Stats" });
  assert.deepEqual(rows.map(({ id, items_30d, selected_30d, shared_30d, first_30d }) => ({ id, items_30d, selected_30d, shared_30d, first_30d })), [
    { id: "stats-a", items_30d: 4, selected_30d: 2, shared_30d: 1, first_30d: 1 },
    { id: "stats-b", items_30d: 2, selected_30d: 0, shared_30d: 2, first_30d: 0 },
    { id: "stats-c", items_30d: 1, selected_30d: 0, shared_30d: 0, first_30d: 0 },
  ]);
});

test("the models page shows paid requests outside the model steps and totals every cost", async () => {
  const before = await modelsOverview(1);
  const call = async (service: string, model: string | null, purpose: string, cost: { amount: number; currency: string; basis: string } | null, usage: Record<string, number> | null = null) => {
    const [r] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, model, purpose, status)
      VALUES (${`cost-view:${randomUUID()}`}, ${service}, ${model}, ${purpose}, 'received') RETURNING id`;
    await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, usage, cost, currency, cost_basis)
      VALUES (${r!.id}, 1, ${service}, ${model}, 'received', ${usage ? sql.json(usage) : null}, ${cost?.amount ?? null}, ${cost?.currency ?? null}, ${cost?.basis ?? null})`;
  };
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok) VALUES ('cost-embed', '', 'USD', 1)`;
  await call("cost-jina", null, "source_detail", { amount: 0.5, currency: "CNY", basis: "estimated" });
  await call("cost-mp", null, "mp_article", { amount: 2, currency: "CNY", basis: "actual" });
  await call("cost-embed", "embed-x", "embedding", null, { prompt_tokens: 2_000_000 });
  await call("cost-llm", "model-x", "score_article", null, { prompt_tokens: 1000, completion_tokens: 10 });

  const m = await modelsOverview(1);
  const other = (service: string) => m.others.find((o) => o.service === service);
  assert.equal(other("cost-jina")?.estimatedCost, 0.5);
  assert.equal(other("cost-mp")?.actualCost, 2);
  assert.deepEqual(other("cost-embed")?.estimate, { amount: 2, currency: "USD" }, "tokens at the unit price");
  assert.equal(other("cost-llm"), undefined, "a model step's call stays with its step");
  assert.equal(m.capabilities.find((c) => c.key === "score")?.usage.find((u) => u.model === "model-x")?.unpriced, 1);

  const grew = (currency: string, kind: "actual" | "estimated") => {
    const at = (x: typeof m) => x.totals.costs.find((c) => c.currency === currency)?.[kind] ?? 0;
    return Math.round((at(m) - at(before)) * 1e6) / 1e6;
  };
  assert.equal(grew("CNY", "actual"), 2);
  assert.equal(grew("CNY", "estimated"), 0.5);
  assert.equal(grew("USD", "estimated"), 2);
  assert.equal(m.totals.unpriced - before.totals.unpriced, 1, "a call with no cost and no price is counted, not guessed");
});
