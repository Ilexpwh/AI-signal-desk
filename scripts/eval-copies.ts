// Calibrates the reprint check (editorial/copies.ts) on this site's own material, read-only.
// Usage: node --env-file=.env scripts/eval-copies.ts [--days 14] [--min-chars 200] [--max 8]
//        node --env-file=.env scripts/eval-copies.ts --labels .data/eval/copies-labels-<time>.csv
// Fingerprints every editorial article discovered in the window as the gate would, pairs articles of
// different sources whose fingerprints lie at most --max bits apart (the later one would be the copy),
// and reports, per distance, what the full judgement did with each pair. Pairs go to a label sheet:
// fill `label` with copy (the later one repeats the earlier), rewrite (the same news in its own words)
// or different, then pass the sheet back with --labels for each distance's precision (docs/selection.md).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { withXArticle } from "@aihot/backend/content/posts";
import { COPY_MAX_DISTANCE, COPY_MIN_CHARS, copyAllowed, copyText, fingerprint } from "@aihot/backend/editorial/copies";
import { positiveInt } from "./eval-tools.ts";

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "14" },
    "min-chars": { type: "string", default: String(COPY_MIN_CHARS) },
    max: { type: "string", default: "8" },
    labels: { type: "string" },
  },
});

const LABELS = ["copy", "rewrite", "different"] as const;
const COLUMNS = ["distance", "outcome", "same_relevance", "later_selected", "earlier_id", "earlier_source", "earlier_title", "later_id", "later_source", "later_title", "label"] as const;
type Outcome = "already-copy" | "same-fact" | "other-fact" | "ungrouped";

interface Material {
  id: string; sourceId: string; tier: string; selectionClass: string | null; title: string; discoveredAt: Date;
  relevance: string | null; copy: boolean; factId: number | null; selected: boolean; hi: number; lo: number;
}

const popcount = (n: number) => {
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (Math.imul((n + (n >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
};

const cell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;

/** RFC 4180 rows: quoted fields may hold commas, quotes and line breaks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((value) => value.trim()));
}

/** Per distance, how many labelled pairs at or below it are copies, and which are not. */
function scoreLabels(file: string) {
  const [header, ...rows] = parseCsv(readFileSync(path.resolve(REPO_ROOT, file), "utf8"));
  const at = (name: string) => header!.indexOf(name);
  const labelled = rows.flatMap((r) => {
    const label = r[at("label")]?.trim().toLowerCase();
    if (!label) return [];
    if (!(LABELS as readonly string[]).includes(label)) throw new Error(`unknown label "${label}" (use ${LABELS.join(", ")})`);
    return [{ distance: Number(r[at("distance")]), label, earlier: r[at("earlier_id")]!, later: r[at("later_id")]! }];
  });
  if (!labelled.length) throw new Error("the sheet has no labelled pairs");
  const max = Math.max(...labelled.map((r) => r.distance));
  console.log(`labelled pairs: ${labelled.length} (current K=${COPY_MAX_DISTANCE})`);
  for (let k = 0; k <= max; k++) {
    const within = labelled.filter((r) => r.distance <= k);
    const copies = within.filter((r) => r.label === "copy").length;
    const different = within.filter((r) => r.label === "different");
    console.log(`  K=${k} pairs=${within.length} copies=${copies} precision=${within.length ? (copies / within.length).toFixed(3) : "-"} different=${different.length}` +
      (different.length ? ` ${different.slice(0, 5).map((r) => `${r.earlier}~${r.later}`).join(" ")}` : ""));
  }
}

async function main() {
  if (values.labels) return scoreLabels(values.labels);
  const days = positiveInt(values.days!, "days");
  const minChars = positiveInt(values["min-chars"]!, "min-chars");
  const max = Number(values.max);
  if (!Number.isInteger(max) || max < 0 || max > 64) throw new Error("--max must be an integer from 0 to 64");

  const materials: Material[] = [];
  let unfingerprinted = 0;
  const cursor = sql<Array<{ id: string; source_id: string; tier: string; selection_class: string | null; title: string; body_text: string | null; excerpt: string | null;
    x_post: Record<string, any> | null; x_article: { title?: string; text?: string } | null; discovered_at: Date; relevance: string | null; copy: boolean; fact_id: number | null; selected: boolean | null }>>`
    SELECT a.id, a.source_id, s.tier, s.selection_class, a.title, a.body_text, a.excerpt, a.x_post, a.x_article, a.discovered_at,
           an.relevance, coalesce(an.output->>'copyOf' IS NOT NULL, false) AS copy, p.selected,
           (SELECT fa.fact_id FROM fact_articles fa WHERE fa.article_id = a.id AND fa.role IN ('primary', 'report') ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1) AS fact_id
    FROM articles a JOIN sources s ON s.id = a.source_id AND s.participation_mode = 'editorial'
    LEFT JOIN LATERAL (SELECT x.relevance, x.output FROM analyses x WHERE x.article_id = a.id ORDER BY x.input_revision DESC, x.id DESC LIMIT 1) an ON true
    LEFT JOIN publications p ON p.article_id = a.id
    WHERE a.discovered_at > now() - make_interval(days => ${days})
    ORDER BY a.discovered_at, a.id`.cursor(500);
  for await (const rows of cursor) {
    for (const r of rows) {
      const h = fingerprint(copyText({ title: r.title, bodyText: r.body_text, excerpt: r.excerpt, xPost: withXArticle(r.x_post, r.x_article) }), minChars);
      if (h === null) { unfingerprinted++; continue; }
      const n = BigInt.asUintN(64, BigInt(h));
      materials.push({
        id: r.id, sourceId: r.source_id, tier: r.tier, selectionClass: r.selection_class, title: r.title, discoveredAt: r.discovered_at,
        relevance: r.relevance, copy: r.copy, factId: r.fact_id === null ? null : Number(r.fact_id), selected: r.selected === true,
        hi: Number(n >> 32n), lo: Number(n & 0xffffffffn),
      });
    }
  }

  // Oldest first, so of each pair the earlier is the original the gate would find.
  const pairs: Array<{ distance: number; outcome: Outcome; sameRelevance: boolean; laterSelected: boolean; earlier: Material; later: Material }> = [];
  let notAllowed = 0;
  for (let j = 0; j < materials.length; j++) {
    const later = materials[j]!;
    for (let i = 0; i < j; i++) {
      const earlier = materials[i]!;
      if (earlier.sourceId === later.sourceId) continue;
      const distance = popcount((earlier.hi ^ later.hi) >>> 0) + popcount((earlier.lo ^ later.lo) >>> 0);
      if (distance > max) continue;
      if (!copyAllowed({ id: later.sourceId, tier: later.tier, selectionClass: later.selectionClass }, { id: earlier.sourceId, tier: earlier.tier, selectionClass: earlier.selectionClass })) {
        notAllowed++;
        continue;
      }
      const outcome: Outcome = earlier.copy || later.copy ? "already-copy"
        : earlier.factId !== null && later.factId !== null ? (earlier.factId === later.factId ? "same-fact" : "other-fact")
        : "ungrouped";
      pairs.push({ distance, outcome, sameRelevance: earlier.relevance === later.relevance, laterSelected: later.selected, earlier, later });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance || +a.later.discoveredAt - +b.later.discoveredAt);

  const histogram = Array.from({ length: max + 1 }, (_, distance) => {
    const at = pairs.filter((p) => p.distance === distance);
    const count = (outcome: Outcome) => at.filter((p) => p.outcome === outcome).length;
    return {
      distance, pairs: at.length,
      sameFact: count("same-fact"), otherFact: count("other-fact"), ungrouped: count("ungrouped"), alreadyCopy: count("already-copy"),
      sameRelevance: at.filter((p) => p.sameRelevance).length, laterSelected: at.filter((p) => p.laterSelected).length,
    };
  });
  for (const row of histogram) {
    console.log(`d=${row.distance} pairs=${row.pairs} same-fact=${row.sameFact} other-fact=${row.otherFact} ungrouped=${row.ungrouped} already-copy=${row.alreadyCopy} same-relevance=${row.sameRelevance} later-selected=${row.laterSelected}`);
  }

  const outDir = path.join(REPO_ROOT, ".data/eval");
  mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const file = path.join(outDir, `copies-${days}d-${stamp}.json`);
  const meta = { days, minChars, max, currentMaxDistance: COPY_MAX_DISTANCE, articles: materials.length + unfingerprinted, unfingerprinted, notAllowed, createdAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify({ meta, histogram }, null, 2));
  const sheet = path.join(outDir, `copies-labels-${stamp}.csv`);
  writeFileSync(sheet, [COLUMNS.join(","), ...pairs.map((p) => [
    p.distance, p.outcome, p.sameRelevance, p.laterSelected, p.earlier.id, p.earlier.sourceId, p.earlier.title, p.later.id, p.later.sourceId, p.later.title, "",
  ].map(cell).join(","))].join("\n") + "\n");
  console.log(`articles=${meta.articles} unfingerprinted=${unfingerprinted} pairs=${pairs.length} not-allowed=${notAllowed}`);
  console.log(`report: ${file}`);
  console.log(`label sheet: ${sheet}`);
}

try {
  await main();
} finally {
  await closeDb();
}
