// Admin "模型与评测": the model each capability uses and where that choice comes from,
// the prompt versions in use, quality / latency / cost of the last days per model, the switch history
// and the SelectBench runs that compare models on the same batch. A switch is audited and applies to
// new work only.
import type { AdminModels, BeforeJson } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { capabilities, capabilityAcceptsModel, fallbackModelFor, invalidateModelCache, modelSources } from "../editorial/models.ts";
import { MODELS } from "../providers/llm.ts";
import { modelCircuits } from "../providers/circuit.ts";
import { audit } from "../audit.ts";

interface UsageRow {
  service: string;
  purpose: string;
  model: string | null;
  prompt_version: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokens_in: string | null;
  /** Prompt tokens served from the provider's cache, among those without a cost of their own. */
  tokens_cached: string | null;
  tokens_out: string | null;
  /** Of calls without a cost of their own. */
  tokens_in_uncosted: string | null;
  tokens_out_uncosted: string | null;
  /** Answered calls that carry no cost of their own. */
  uncosted: number;
  actual_cost: string | null;
  /** What the provider client estimated itself, from the units it was billed for. */
  estimated_cost: string | null;
  currency: string | null;
}

/** Calls, outcomes, latency, tokens and costs of a group of live attempts. */
const usageColumns = () => sql`
  count(*)::int AS calls,
  count(*) FILTER (WHERE a.status = 'received')::int AS ok,
  count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
  count(*) FILTER (WHERE a.status = 'unknown')::int AS unknown,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95,
  sum((a.usage->>'prompt_tokens')::bigint) AS tokens_in, sum((a.usage->>'completion_tokens')::bigint) AS tokens_out,
  sum((a.usage->>'prompt_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_in_uncosted,
  sum((a.usage->>'completion_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_out_uncosted,
  sum(coalesce((a.usage->'prompt_tokens_details'->>'cached_tokens')::bigint, (a.usage->>'prompt_cache_hit_tokens')::bigint, 0)) FILTER (WHERE a.cost IS NULL) AS tokens_cached,
  count(*) FILTER (WHERE a.cost IS NULL AND a.status = 'received')::int AS uncosted,
  sum(a.cost) FILTER (WHERE a.cost_basis = 'actual') AS actual_cost,
  sum(a.cost) FILTER (WHERE a.cost_basis = 'estimated') AS estimated_cost,
  max(a.currency) AS currency`;

export async function modelsOverview(days = 7): Promise<BeforeJson<AdminModels>> {
  const since = new Date(Date.now() - days * 86400_000);
  const stepPurposes = Object.values(capabilities()).flatMap((c) => c.purposes);
  const [sources, circuits, usage, otherUsage, prices, history, benches] = await Promise.all([
    modelSources(),
    modelCircuits(),
    sql<UsageRow[]>`
      SELECT a.service, r.purpose, a.model, r.request->>'promptVersion' AS prompt_version, ${usageColumns()}
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at >= ${since} AND a.origin = 'live' AND a.model IS NOT NULL AND r.purpose = ANY(${stepPurposes}::text[])
      GROUP BY 1, 2, 3, 4 ORDER BY 2, 5 DESC`,
    sql<UsageRow[]>`
      SELECT a.service, r.purpose, a.model, NULL AS prompt_version, ${usageColumns()}
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at >= ${since} AND a.origin = 'live' AND (a.model IS NULL OR NOT (r.purpose = ANY(${stepPurposes}::text[])))
      GROUP BY 1, 2, 3 ORDER BY 1, 5 DESC`,
    sql<{ service: string; model: string; currency: string; input_per_mtok: string | null; cached_per_mtok: string | null; output_per_mtok: string | null }[]>`
      SELECT service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok FROM service_prices`,
    sql<BeforeJson<AdminModels["history"][number]>[]>`
      SELECT created_at AS at, actor, subject, reason, before, after FROM audit_log WHERE action = 'models.switch' ORDER BY created_at DESC LIMIT 30`,
    sql<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; summary: unknown; created_at: Date }[]>`
      SELECT id, label, sample_size, prompt_version, models,
             (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
             created_at FROM selectbench_runs r ORDER BY created_at DESC LIMIT 8`,
  ]);
  // Cached prompt tokens at the cache price, the rest at the input price; calls that carry their own cost
  // are not estimated again.
  const priced = (u: UsageRow) => {
    if (!u.uncosted) return null;
    const p = prices.find((x) => x.service === u.service && x.model === u.model) ?? prices.find((x) => x.service === u.service && x.model === "");
    if (!p || (!p.input_per_mtok && !p.output_per_mtok)) return null;
    const cached = Number(u.tokens_cached ?? 0);
    const fresh = Number(u.tokens_in_uncosted ?? 0) - cached;
    const amount = (fresh / 1e6) * Number(p.input_per_mtok ?? 0) + (cached / 1e6) * Number(p.cached_per_mtok ?? p.input_per_mtok ?? 0) + (Number(u.tokens_out_uncosted ?? 0) / 1e6) * Number(p.output_per_mtok ?? 0);
    return { amount, currency: p.currency };
  };
  const view = (u: UsageRow) => {
    const estimate = priced(u);
    return {
      purpose: u.purpose,
      model: u.model,
      calls: u.calls,
      ok: u.ok,
      failed: u.failed,
      unknown: u.unknown,
      p50: u.p50,
      p95: u.p95,
      tokensIn: Number(u.tokens_in ?? 0),
      tokensOut: Number(u.tokens_out ?? 0),
      actualCost: u.actual_cost === null ? null : Number(u.actual_cost),
      estimatedCost: u.estimated_cost === null ? null : Number(u.estimated_cost),
      currency: u.currency,
      estimate,
      unpriced: estimate ? 0 : u.uncosted,
    };
  };
  const others = otherUsage.map((u) => ({ service: u.service, ...view(u) }));
  const rows = [...usage.map(view), ...others];
  const costs = new Map<string, { currency: string; actual: number; estimated: number }>();
  const add = (currency: string, kind: "actual" | "estimated", amount: number | null) => {
    if (!amount) return;
    const c = costs.get(currency) ?? { currency, actual: 0, estimated: 0 };
    c[kind] += amount;
    costs.set(currency, c);
  };
  for (const r of rows) {
    add(r.currency ?? "CNY", "actual", r.actualCost);
    add(r.currency ?? "CNY", "estimated", r.estimatedCost);
    if (r.estimate) add(r.estimate.currency, "estimated", r.estimate.amount);
  }
  const totals = { costs: [...costs.values()].sort((a, b) => a.currency.localeCompare(b.currency)), unpriced: rows.reduce((n, r) => n + r.unpriced, 0) };
  const steps = Object.entries(capabilities()).map(([key, c]) => {
    const backup = fallbackModelFor(key, sources[key]!.model);
    const primaryCircuit = circuits[MODELS[sources[key]!.model]!.service];
    const backupCircuit = backup ? circuits[MODELS[backup]!.service] : undefined;
    return {
      key,
      label: c.label,
      env: c.env,
      defaultModel: c.default,
      vision: !!c.vision,
      current: sources[key]!,
      fallback: backup ? { model: backup, primaryPaused: !!primaryCircuit?.openUntil, backupPaused: !!backupCircuit?.openUntil,
        nextProbeAt: primaryCircuit?.openUntil ? new Date(Math.max(primaryCircuit.openUntil, primaryCircuit.probeUntil)).toISOString() : null } : null,
      usage: usage.filter((u) => c.purposes.includes(u.purpose)).map((u) => ({ ...view(u), promptVersion: u.prompt_version })),
    };
  });
  const choices = Object.values(MODELS).map((m) => ({ key: m.key, service: m.service, vision: !!m.vision }));
  return { days, capabilities: steps, others, totals, choices, history, benches };
}

/** Switches a capability to another registered model (or back to the environment/default when null). */
export async function switchModel(capability: string, model: string | null, reason: string, actor: string) {
  const c = capabilities()[capability];
  if (!c) throw Object.assign(new Error("unknown capability"), { statusCode: 400 });
  if (!reason.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  if (model !== null) {
    const spec = MODELS[model];
    if (!spec) throw Object.assign(new Error("unknown model"), { statusCode: 400 });
    if (!capabilityAcceptsModel(c, spec)) throw Object.assign(new Error("this capability needs a vision model"), { statusCode: 400 });
  }
  const before = (await modelSources())[capability];
  if (model === null) await sql`DELETE FROM settings WHERE key = ${`models.${capability}`}`;
  else {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${`models.${capability}`}, ${sql.json({ model })}, ${actor})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }
  invalidateModelCache();
  const after = (await modelSources())[capability];
  await audit(actor, "models.switch", `capability:${capability}`, reason, before ?? null, after ?? null);
  return { capability, before, after };
}
