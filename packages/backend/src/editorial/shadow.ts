// The shadow of a step: a decision model (Jev) answers the same questions about the same material as the
// model step already did, so the two can be compared on real traffic (scripts/eval-jev-shadow.ts) before
// anything depends on it. Turned on per step from the admin's model page (settings `shadow.<step>`); it
// writes receipts only, never analyses, so nothing a reader sees changes.
import { sql } from "../db.ts";
import { logError } from "../lib/log-error.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { failureKind, ProviderRejectedError } from "../providers/receipts.ts";
import { loadAnalyzeInput } from "./input.ts";
import { DECISION_STEPS, DECISION_VERSIONS, decidePrefilter, decideScore, type DecisionStep } from "./decisions.ts";

/** At most this many judgements per step and run: a run every five minutes keeps up with the site's intake. */
const PER_RUN = 100;

/** Valve off, budget spent, the same request in flight, the service down or the key refused: the next run tries again. */
const endsRun = (error: unknown) => ["off", "budget", "busy", "outage"].includes(failureKind(error))
  || (error instanceof ProviderRejectedError && error.accessRefused);

/** The decision model shadowing each step, from the admin's switches. */
export async function shadowModels(): Promise<Partial<Record<DecisionStep, string>>> {
  const rows = await sql<{ key: string; value: { model?: unknown } }[]>`SELECT key, value FROM settings WHERE key LIKE 'shadow.%'`;
  const out: Partial<Record<DecisionStep, string>> = {};
  for (const r of rows) {
    const step = r.key.slice("shadow.".length);
    if (Object.hasOwn(DECISION_STEPS, step) && typeof r.value?.model === "string") out[step as DecisionStep] = r.value.model;
  }
  return out;
}

/**
 * Asks the shadow model about the newest current judgements of each shadowed step it has not been asked
 * about yet (any receipt for the article's revision and the questions' version counts, so a refused or
 * unusable answer is not paid for again). One bad answer skips that article.
 */
export async function shadowDecisions(opts: { budgetMs?: number } = {}): Promise<{ asked: number; failed: number }> {
  const started = Date.now();
  let asked = 0;
  let failed = 0;
  for (const [step, model] of Object.entries(await shadowModels()) as Array<[DecisionStep, string]>) {
    const purpose = DECISION_STEPS[step];
    const judged = step === "prefilter" ? sql`an.output->'prefilter'->>'label' IS NOT NULL` : sql`jsonb_typeof(an.output->'scores') = 'array'`;
    const rows = await sql<{ article_id: string }[]>`
      SELECT an.article_id FROM analyses an JOIN articles ar ON ar.id = an.article_id AND ar.revision = an.input_revision
      WHERE an.origin = 'model' AND an.created_at > now() - interval '2 days' AND ${judged}
        AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.subject = 'article:' || ar.id || '@' || ar.revision
                          AND r.purpose = ${purpose} AND r.service = 'typesafe' AND r.request->>'promptVersion' = ${DECISION_VERSIONS[step]})
      GROUP BY an.article_id ORDER BY max(an.id) DESC LIMIT ${PER_RUN}`;
    for (const { article_id } of rows) {
      if (Date.now() - started > (opts.budgetMs ?? 4 * 60_000) || shutdownSignal.signal.aborted) return { asked, failed };
      const input = await loadAnalyzeInput(article_id);
      if (!input) continue;
      try {
        if (step === "prefilter") await decidePrefilter(input, model);
        else await decideScore(input, model);
        asked += 1;
      } catch (error) {
        if (endsRun(error)) {
          console.warn(JSON.stringify({ level: "warn", msg: "shadow decisions stopped", step, model, kind: failureKind(error) }));
          return { asked, failed };
        }
        failed += 1;
        console.warn(JSON.stringify({ level: "warn", msg: "shadow decision failed", step, model, articleId: article_id, err: logError(error) }));
      }
    }
  }
  return { asked, failed };
}
