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
