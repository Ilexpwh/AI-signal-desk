// Reprints. Material that repeats an article another source already had judged is that article's copy:
// before any paid step (jobs/content.ts) it takes the original's judgement without a model call, joins
// the original's fact as one more report (events/group.ts) and stays out of the pool and the selection
// (publication/publish.ts), while it still counts as coverage and heat. A copy is told by a 64-bit SimHash
// of its text (articles.simhash, written with every judgement) within COPY_MAX_DISTANCE bits of the
// original's. Both numbers are starting values: a site sets them from pairs it labels
// (scripts/eval-copies.ts, docs/selection.md). An explicit re-evaluation always judges in full,
// and so does a withdrawal or correction of the original for its copies (admin/content.ts).
import { sql, type Db } from "../db.ts";
import { RECALL_DAYS } from "../events/recall.ts";
import { isIndependentSelectedSource } from "../publication/rules.ts";
import { selectionThreshold, waitsForPage } from "./analyze.ts";
import { loadAnalyzeInput, type AnalyzeInputArticle } from "./input.ts";

/** Fingerprints that differ in at most this many of their 64 bits are one text. */
export const COPY_MAX_DISTANCE = 3;
/** Text shorter than this, once normalised, gets no fingerprint: too little to tell a reprint from a coincidence. */
export const COPY_MIN_CHARS = 200;

/** The text a reprint repeats: the title and the whole body, or a post's text and the post it quotes. */
export function copyText(a: Pick<AnalyzeInputArticle, "title" | "bodyText" | "excerpt" | "xPost">): string {
  const body = a.xPost ? `${a.xPost.text ?? ""}\n${a.xPost.quoted?.text ?? ""}` : a.bodyText ?? a.excerpt ?? "";
  return `${a.title}\n${body}`;
}

/** murmur3's finaliser: every input bit reaches every output bit. */
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const gram = (a: number, b: number, c: number, seed: number) =>
  mix(Math.imul(Math.imul(Math.imul(seed ^ a, 0x01000193) ^ b, 0x01000193) ^ c, 0x01000193));

/**
 * The 64-bit SimHash over the character 3-grams of `text`, NFKC-normalised and lower-cased, with links,
 * punctuation, symbols and spacing taken out (a reprint re-flows and re-links what it copies), as the
 * decimal text of the signed number PostgreSQL's bigint stores; null below `minChars`. It is written as a
 * parameter and compared in SQL: read back, the database layer would round it to a JavaScript number.
 */
export function fingerprint(text: string, minChars = COPY_MIN_CHARS): string | null {
  const normalised = text.normalize("NFKC").toLowerCase()
    .replace(/https?:\/\/[\x21-\x7e]+|\bwww\.[\x21-\x7e]+/g, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  const chars = Array.from(normalised, (c) => c.codePointAt(0)!);
  if (chars.length < minChars) return null;
  const weights = new Int32Array(64);
  for (let i = 0; i + 2 < chars.length; i++) {
    const lo = gram(chars[i]!, chars[i + 1]!, chars[i + 2]!, 0x811c9dc5);
    const hi = gram(chars[i]!, chars[i + 1]!, chars[i + 2]!, 0x9e3779b9);
    for (let bit = 0; bit < 32; bit++) {
      weights[bit]! += (lo >>> bit) & 1 ? 1 : -1;
      weights[bit + 32]! += (hi >>> bit) & 1 ? 1 : -1;
    }
  }
  let lo = 0, hi = 0;
  for (let bit = 0; bit < 32; bit++) {
    if (weights[bit]! > 0) lo |= 1 << bit;
    if (weights[bit + 32]! > 0) hi |= 1 << bit;
  }
  return String(BigInt.asIntN(64, (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)));
}

interface SourceRank { id: string; tier: string; selectionClass?: string | null }

/**
 * Whether material from source `copy` may take a judgement made for source `original`: only when the
 * copy's threshold is at least the original's, so a first-party post never becomes a copy of a media
 * reprint judged against a higher line (a tier without a threshold ranks above every one); never for a
 * source shown as an independent selected source, whose articles keep their own judgement and card.
 */
export function copyAllowed(copy: SourceRank, original: SourceRank): boolean {
  if (isIndependentSelectedSource(copy.id) || isIndependentSelectedSource(original.id)) return false;
  return (selectionThreshold(copy) ?? Infinity) >= (selectionThreshold(original) ?? Infinity);
}

interface Original { id: string; analysisId: number; relevance: "pass" | "block"; groupingStatus: string; distance: number }

/**
 * The article `a` repeats: the closest fingerprint within COPY_MAX_DISTANCE among the editorial articles
 * of other sources discovered in the recall window whose current judgement is a pass or a block, itself
 * no copy, neither withdrawn nor corrected by an editor, and one `a` may copy (copyAllowed).
 */
export async function findOriginal(h: string, a: AnalyzeInputArticle): Promise<Original | null> {
  const rows = await sql<Array<Original & { source_id: string; tier: string; selection_class: string | null }>>`
    SELECT o.id, an.id AS "analysisId", an.relevance, o.grouping_status AS "groupingStatus", s.id AS source_id, s.tier, s.selection_class,
      bit_count((o.simhash # ${h}::bigint)::bit(64))::int AS distance
    FROM articles o
    JOIN sources s ON s.id = o.source_id AND s.participation_mode = 'editorial'
    JOIN LATERAL (SELECT x.id, x.input_revision, x.relevance, x.output FROM analyses x WHERE x.article_id = o.id
                  ORDER BY x.input_revision DESC, x.id DESC LIMIT 1) an ON an.input_revision = o.revision
    WHERE o.simhash IS NOT NULL AND o.discovered_at > now() - make_interval(days => ${RECALL_DAYS})
      AND bit_count((o.simhash # ${h}::bigint)::bit(64)) <= ${COPY_MAX_DISTANCE}
      AND o.source_id <> ${a.source.id} AND o.id <> ${a.id}
      AND an.relevance IN ('pass', 'block') AND an.output->>'copyOf' IS NULL
      AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.article_id = o.id AND p.visibility = 'withdrawn')
      AND NOT EXISTS (SELECT 1 FROM editorial_overrides e WHERE e.article_id = o.id)
    ORDER BY distance, o.discovered_at, o.id`;
  const found = rows.find((r) => copyAllowed(a.source, { id: r.source_id, tier: r.tier, selectionClass: r.selection_class }));
  return found ? { id: found.id, analysisId: found.analysisId, relevance: found.relevance, groupingStatus: found.groupingStatus, distance: found.distance } : null;
}

export interface CopyResult { analysisId: number; stale: boolean; relevance: "pass" | "block" }

/**
 * The original's judgement committed as the copy's: a rule analysis with its relevance, copy, category,
 * tags and structure, never selected, its output naming the original (copyOf) and how far the
 * fingerprints lie apart. As with analyzeArticle, a result for an older revision is kept without
 * overwriting the newer one (stale). Null when an editor has withdrawn or corrected the original since it
 * was found: that judgement is no longer the site's, and the copy is judged in full.
 */
export async function commitCopy(a: AnalyzeInputArticle, original: Original, h: string): Promise<CopyResult | null> {
  return sql.begin(async (tx) => {
    // A withdrawal or correction locks the original before it sends the original's copies back to be
    // judged (admin/content.ts). Locked first, in the same order, either that finds this copy or this
    // sees it, read after the lock.
    await tx`SELECT 1 FROM articles WHERE id = ${original.id} FOR KEY SHARE`;
    const [moderated] = await tx`
      SELECT 1 WHERE EXISTS (SELECT 1 FROM publications p WHERE p.article_id = ${original.id} AND p.visibility = 'withdrawn')
        OR EXISTS (SELECT 1 FROM editorial_overrides e WHERE e.article_id = ${original.id})`;
    if (moderated) return null;
    const [current] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${a.id} FOR UPDATE`;
    const stale = !current || current.revision !== a.revision;
    const [row] = await tx<{ id: number; relevance: "pass" | "block" }[]>`
      INSERT INTO analyses (article_id, input_revision, origin, prompt_version, relevance, category, tags, subjects, title_zh, summary_zh, reason_zh, score, selected, output)
      SELECT ${a.id}, ${a.revision}, 'rule', o.prompt_version, o.relevance, o.category, o.tags, o.subjects, o.title_zh, o.summary_zh, o.reason_zh, o.score, false,
        jsonb_build_object('copyOf', ${original.id}::text, 'copyOfAnalysis', o.id, 'distance', ${original.distance}::int, 'scope', o.output->'scope', 'fact', o.output->'fact')
      FROM analyses o WHERE o.id = ${original.analysisId}
      RETURNING id, relevance`;
    if (!stale) {
      await tx`UPDATE articles SET processing_state = ${row!.relevance === "block" ? "blocked" : "analyzed"}, processing_error = NULL, simhash = ${h} WHERE id = ${a.id}`;
    }
    return { analysisId: row!.id, stale, relevance: row!.relevance };
  });
}

/**
 * The copy check, before any paid step. Null: the article repeats no original it may copy, or the one it
 * repeats was withdrawn or corrected meanwhile, and is judged in full.
 * `waiting`: it repeats a passed original whose grouping is still pending, and waits for it, so that it
 * joins the fact the original gets.
 */
export async function judgeAsCopy(articleId: string): Promise<({ waiting: false } & CopyResult) | { waiting: true } | null> {
  const a = await loadAnalyzeInput(articleId);
  // Material still waiting for its page is fingerprinted on the page, once extraction has it.
  if (!a || waitsForPage(a)) return null;
  const h = fingerprint(copyText(a));
  if (h === null) return null;
  const original = await findOriginal(h, a);
  if (!original) return null;
  if (original.relevance === "pass" && original.groupingStatus === "pending") return { waiting: true };
  const committed = await commitCopy(a, original, h);
  return committed && { waiting: false, ...committed };
}

/**
 * The reprints whose current judgement is `originalId`'s, first discovered first: what the original's
 * page lists, and what goes back to be judged when an editor withdraws or corrects it.
 */
export function copiesOf(db: Db, originalId: string) {
  return db<{ id: string; title: string; source_name: string; distance: number; discovered_at: Date }[]>`
    SELECT c.id, coalesce(p.title, c.title) AS title, s.name AS source_name, (cx.output->>'distance')::int AS distance, c.discovered_at
    FROM analyses cx JOIN articles c ON c.id = cx.article_id JOIN sources s ON s.id = c.source_id LEFT JOIN publications p ON p.article_id = c.id
    WHERE cx.output->>'copyOf' = ${originalId}
      AND cx.id = (SELECT x.id FROM analyses x WHERE x.article_id = c.id ORDER BY x.input_revision DESC, x.id DESC LIMIT 1)
    ORDER BY c.discovered_at, c.id`;
}
