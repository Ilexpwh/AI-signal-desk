// Calibrates attaching clear matches without the relation judge (events/group.ts AUTO_ATTACH), read-only.
// Usage: node --env-file=.env scripts/eval-recall-thresholds.ts [--days 30] [--cosine 0.93 --margin 0.05] [--examples 20]
// Replays the reports the judge answered about: the nearest recalled fact, how far ahead of the next one
// it was, whether both name the same company, and whether the judge called that fact the same occurrence.
// For each score floor and margin it prints how many judge calls auto-attach would have saved and how often
// it would have joined a fact the judge did not; with --cosine and --margin, the disagreements to read
// (docs/grouping.md). Embedding scores only: run it on a site with an embedding key. The judge's answer is
// the reference here, not a label: read the disagreements before trusting a cell.
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { AUTO_ATTACH, CONFIRM_BELOW_COSINE, RECALL_MIN_COSINE } from "@aihot/backend/events/group";
import { sameSubject } from "@aihot/backend/events/relate";
import { positiveInt } from "./eval-tools.ts";

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "30" },
    cosine: { type: "string" },
    margin: { type: "string" },
    examples: { type: "string", default: "20" },
  },
});
const days = positiveInt(values.days!, "--days");
const examples = positiveInt(values.examples!, "--examples");

interface Candidate { id: number; score: number; relation?: string; confidence?: number }
interface Case { articleId: string; title: string; subject: string | null; top: Candidate; topTitle: string; topSubject: string | null; next: number; same: boolean }

// Judged decisions only: a receipt means the batch judge answered; the same URL, a revision that kept its
// fact, a roundup and an auto-attach are decided without it. Recalled posts and the same URL are scored 1,
// not by cosine, and the code never auto-attaches them: those reports are left out.
const rows = await sql<{ article_id: string; title: string; subject: string | null; candidates: Candidate[] }[]>`
  SELECT d.article_id, coalesce(p.title, a.title) AS title, d.candidates,
    (SELECT x.output->'fact'->>'subject' FROM analyses x WHERE x.article_id = d.article_id AND x.created_at <= d.created_at
      ORDER BY x.input_revision DESC, x.id DESC LIMIT 1) AS subject
  FROM grouping_decisions d JOIN articles a ON a.id = d.article_id LEFT JOIN publications p ON p.article_id = d.article_id
  WHERE d.created_at > now() - make_interval(days => ${days}) AND d.receipt_id IS NOT NULL
    AND d.verdict IN ('same-fact', 'same-card', 'new-fact-in-story', 'new-story') AND jsonb_array_length(d.candidates) > 0
  ORDER BY d.id`;
const ranked = rows.flatMap((r) => {
  const cands = [...r.candidates].sort((a, b) => b.score - a.score);
  return cands[0] && cands[0].score < 1 && cands[0].relation ? [{ ...r, top: cands[0], next: cands[1]?.score ?? RECALL_MIN_COSINE }] : [];
});
const facts = new Map((await sql<{ id: number; title: string; subject: string | null }[]>`
  SELECT id, title, subject FROM facts WHERE id = ANY(${[...new Set(ranked.map((r) => r.top.id))]})`).map((f) => [Number(f.id), f]));
const cases: Case[] = ranked.map((r) => {
  const fact = facts.get(Number(r.top.id));
  return { articleId: r.article_id, title: r.title, subject: r.subject, top: r.top, topTitle: fact?.title ?? "", topSubject: fact?.subject ?? null, next: r.next, same: r.top.relation === "SAME_OCCURRENCE" };
});
await closeDb();

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
const auto = (c: Case, cosine: number, margin: number) =>
  c.top.score >= Math.max(cosine, CONFIRM_BELOW_COSINE) && c.top.score - c.next >= margin && sameSubject(c.subject, c.topSubject);

const subjectCases = cases.filter((c) => sameSubject(c.subject, c.topSubject));
console.log(`judged reports in ${days} days: ${rows.length}; with a cosine-scored nearest fact: ${cases.length}; same company on both sides: ${subjectCases.length}`);
console.log(`judge called the nearest fact the same occurrence: ${pct(cases.filter((c) => c.same).length, cases.length)} of all, ${pct(subjectCases.filter((c) => c.same).length, subjectCases.length)} of same-company`);
console.log(`current setting: cosine ${AUTO_ATTACH.cosine}, margin ${AUTO_ATTACH.margin} (never below ${CONFIRM_BELOW_COSINE})\n`);

// Per cell: reports auto-attached (share of judged reports, i.e. judge calls saved) and the judge's agreement.
const MARGINS = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.15];
console.log(["cosine", ...MARGINS.map((g) => `margin ${g}`)].map((s) => s.padEnd(20)).join(""));
for (let t = Math.round(CONFIRM_BELOW_COSINE * 100); t <= 99; t++) {
  const cells = MARGINS.map((g) => {
    const hit = cases.filter((c) => auto(c, t / 100, g));
    return `${hit.length} ${pct(hit.length, rows.length)} ok ${pct(hit.filter((c) => c.same).length, hit.length)}`;
  });
  console.log([`${t / 100}`, ...cells].map((s) => s.padEnd(20)).join(""));
}

if (values.cosine !== undefined || values.margin !== undefined) {
  const cosine = Number(values.cosine ?? AUTO_ATTACH.cosine);
  const margin = Number(values.margin ?? AUTO_ATTACH.margin);
  if (!Number.isFinite(cosine) || !Number.isFinite(margin)) throw new Error("--cosine and --margin are numbers");
  const hit = cases.filter((c) => auto(c, cosine, margin));
  const wrong = hit.filter((c) => !c.same);
  console.log(`\ncosine ${cosine}, margin ${margin}: ${hit.length} auto-attached (${pct(hit.length, rows.length)} of judge calls), ${wrong.length} the judge did not call the same occurrence`);
  for (const c of wrong.slice(0, examples)) {
    console.log(`- ${c.articleId} score ${c.top.score.toFixed(3)} next ${c.next.toFixed(3)} judge ${c.top.relation} ${c.top.confidence ?? ""}`);
    console.log(`  report: ${c.title}\n  fact:   ${c.topTitle}`);
  }
}
