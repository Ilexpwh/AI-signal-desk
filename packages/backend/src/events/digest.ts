// Story digest: rewritten incrementally as reports arrive; contradictions with earlier reporting are
// stated explicitly. Latest progress is bound to a current public report, not generated independently.
// Each sentence cites the reports it rests on and is published only when they support it.
import { z } from "zod";
import { modelFor } from "../editorial/models.ts";
import { grounded } from "../editorial/grounding.ts";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { firstReleases } from "../publication/representative.ts";
import { digestFactEvidence, digestInputsHash, digestReports, type DigestReport, type DigestSentence } from "../publication/story-evidence.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";

export const DIGEST_PROMPT_VERSION = promptVersion("story-digest");

export const DIGEST_SYSTEM = promptText("story-digest");

/** A sentence without a usable list of reports reads as uncited, and is dropped as such (citedSentences). */
export const DigestSchema = z.object({
  title: z.string().max(120).catch(""),
  sentences: z.array(z.object({
    text: z.string().max(500),
    reports: z.array(z.string()).catch([]),
    newParagraph: z.boolean().catch(false),
  })).min(1).max(30),
});

/** Sampling of every digest request. */
export const DIGEST_SAMPLING = { temperature: 0.3, maxTokens: 1200 };

/** Shorter than this once its unsupported sentences are dropped, a digest is not published: the previous version stays, or the story has none. */
export const DIGEST_MIN_CHARS = 100;

/** Oldest first; reports from the same moment keep the order digestReports returned them in. */
export const byReportTime = (a: { at: Date }, b: { at: Date }) => a.at.getTime() - b.at.getTime();

/** The most reports one digest request reads: every fact's 首发, then the latest of the others. */
const DIGEST_MAX_REPORTS = 40;

type Report = Omit<DigestReport, "story_id">;

/** The reports one digest request lists, in its order, from reports in byReportTime order: every fact's 首发 first, then the latest of the others. */
export function listedReports<T extends Report>(reports: T[]): { listed: T[]; firsts: Set<string> } {
  const firsts = firstReleases(reports);
  const lead = reports.filter((r) => firsts.has(r.id)).slice(-DIGEST_MAX_REPORTS);
  const rest = reports.filter((r) => !firsts.has(r.id));
  return { listed: [...lead, ...rest.slice(Math.max(0, rest.length - (DIGEST_MAX_REPORTS - lead.length)))], firsts };
}

/**
 * The digest request's input, from one story's reports in byReportTime order. Each fact's 首发 (publication/
 * representative.ts firstReleases) is listed first, so the digest attributes the fact to it before the
 * reports that relay it; a story without one reads by time alone, as before. The evaluation
 * (scripts/eval-story-digests.ts) sends this, the system prompt and the sampling above as they are.
 */
export function buildStoryDigestInput(story: { title: string; digest: string | null }, reports: Report[], opts: { corrected: boolean; knownArticleIds?: string[] }) {
  const known = new Set(opts.knownArticleIds ?? []);
  const { listed, firsts } = listedReports(reports);
  const lines = listed.map((r) => `${opts.corrected || known.has(r.id) ? "" : "【新】"}${firsts.has(r.id) ? "【首发】" : ""}报道 ${r.id}｜事实 ${r.fact_id}｜${beijingDate(r.at)} ${beijingTime(r.at)}｜${r.source_name}${r.first_party ? "（一手）" : ""}｜${r.title}｜${r.summary ?? ""}\n事实条件与来源证据：${JSON.stringify(digestFactEvidence(r))}`);
  const order = firsts.size ? "标【首发】的是官方或当事方自己的账号对所属事实最早的发布，排在最前，写到这个事实时先归于它；其余按时间" : "按时间";
  return opts.corrected
    ? `事件当前标题：${story.title}\n\n报道内容或事实证据经过更正。请只依据下面这些报道的当前内容重写综述，不要沿用以前版本的说法。\n报道（${order}）：\n${lines.join("\n")}`
    : `事件当前标题：${story.title}\n${story.digest ? `上一版综述：${story.digest}\n` : ""}\n报道（${order}，标【新】的是上一版之后的新报道）：\n${lines.join("\n")}`;
}

/** Why a sentence is not published: it cites nothing, cites a report its request did not list, or names what its reports do not. */
export type DroppedReason = "uncited" | "unlisted" | "unsupported";

/** What a sentence may take from a report it cites: the report's title, summary and source, and its fact's evidence. */
function citable(r: Report): string {
  const e = digestFactEvidence(r);
  return [r.title, r.summary, r.source_name, e.subject, e.action, e.object, e.conditions, e.evidence, e.extractedEvidence,
    ...e.extractedConditions.flatMap((c) => [c.text, c.quote])].filter(Boolean).join("\n");
}

/** Every number a text writes, whole: 2026-11-08 writes 2026, 11 and 8, as 11 月 8 日 writes 11 and 8. */
const numbersIn = (text: string) => (text.normalize("NFKC").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ""));

/**
 * The sentences a digest publishes, in the model's order: each cites at least one report, only reports its
 * request listed, and names nothing those reports do not: every number (a date's month and day too) as a
 * whole number, and the Latin-script names, figures and companies grounded() checks. The rest are dropped;
 * a paragraph whose first sentence was dropped opens at its next kept one.
 */
export function citedSentences(sentences: DigestSentence[], listed: Report[]): { kept: DigestSentence[]; dropped: Array<DigestSentence & { reason: DroppedReason }> } {
  const byId = new Map(listed.map((r) => [r.id, r]));
  const kept: DigestSentence[] = [];
  const dropped: Array<DigestSentence & { reason: DroppedReason }> = [];
  let opens = false;
  for (const sentence of sentences) {
    const text = sentence.text.trim();
    if (!text) continue;
    const reports = [...new Set(sentence.reports)];
    opens ||= sentence.newParagraph;
    const cited = reports.flatMap((id) => byId.get(id) ?? []);
    const corpus = cited.map(citable).join("\n");
    const known = new Set(numbersIn(corpus));
    const reason: DroppedReason | null = !reports.length ? "uncited" : cited.length < reports.length ? "unlisted"
      : grounded(text, corpus) && numbersIn(text).every((n) => known.has(n)) ? null : "unsupported";
    if (reason) {
      dropped.push({ text, reports, newParagraph: sentence.newParagraph, reason });
      continue;
    }
    kept.push({ text, reports, newParagraph: kept.length > 0 && opens });
    opens = false;
  }
  return { kept, dropped };
}

/** The digest every reader gets: its sentences in order, a blank line between paragraphs. */
export function digestText(sentences: DigestSentence[]): string {
  return sentences.map((s, i) => (i === 0 ? "" : s.newParagraph ? "\n\n" : /[!-~]$/.test(sentences[i - 1]!.text) ? " " : "") + s.text).join("");
}

/**
 * A story's digest from its current reports. It is written again when the reports it was written from
 * change, when a report joins with a fact the digest does not cover yet, or when a first-hand report joins;
 * other new reports only repeat what it says and leave it as it is. `rewrite` (rewriteStoryDigest) writes it
 * again from the reports as they are now with the current prompt, as after a correction: a new wording
 * otherwise reaches a story only when its digest is written again.
 */
export async function composeStoryDigest(storyId: number, opts: { rewrite?: boolean } = {}): Promise<{ updated: boolean; version?: number; tooShort?: true }> {
  const [story] = await sql<{ id: number; title: string; digest: string | null; version: number; origin: string }[]>`
    SELECT id, title, digest, version, origin FROM stories WHERE id = ${storyId} AND merged_into IS NULL`;
  if (!story) return { updated: false };
  const reports = await digestReports(sql, [storyId]);
  if (reports.length === 0) {
    const cleared = await sql`UPDATE stories SET digest = NULL, latest = NULL, digest_updated_at = NULL, updated_at = now()
      WHERE id = ${storyId} AND version = ${story.version} AND merged_into IS NULL AND (digest IS NOT NULL OR latest IS NOT NULL)`;
    return { updated: cleared.count > 0 };
  }
  reports.sort(byReportTime);
  const ids = reports.map((r) => r.id).sort();
  // What this version is written from: the reports and what they currently say (corrections included).
  const inputsHash = digestInputsHash(reports);
  const [last] = await sql<{ article_ids: string[]; inputs_hash: string | null; digest: string; citations: DigestSentence[] | null; receipt_id: number | null }[]>`
    SELECT article_ids, inputs_hash, digest, citations, receipt_id FROM story_digests WHERE story_id = ${storyId} ORDER BY version DESC LIMIT 1`;
  const sameReports = !!last && JSON.stringify([...last.article_ids].sort()) === JSON.stringify(ids);
  if (!opts.rewrite && story.digest !== null && sameReports && last!.inputs_hash === inputsHash) return { updated: false };
  const saved = reports.filter((r) => last?.article_ids.includes(r.id));
  const dropped = !!last && last.article_ids.some((id) => !ids.includes(id));
  const changed = !!last && digestInputsHash(saved) !== last.inputs_hash;
  // Reports that joined since, while the published digest's own reports stand unchanged (story-text.ts keeps
  // showing it): only repeating facts it covers, none of them first-hand, they leave it as it is.
  const covered = new Set(saved.map((r) => r.fact_id));
  const joined = reports.filter((r) => !last?.article_ids.includes(r.id));
  if (!opts.rewrite && last && story.digest === last.digest && !dropped && !changed && joined.every((r) => covered.has(r.fact_id) && !r.first_hand)) return { updated: false };
  // Same reports, different content: an editor corrected one. A report gone from the story (withdrawn,
  // or regrouped elsewhere) likewise, and a corrected one beside new reports. Rewrite from the reports as
  // they are now, without the previous digest, so a corrected or withdrawn fact does not survive as
  // "earlier reports said".
  const corrected = opts.rewrite === true || sameReports || dropped || changed;
  const user = buildStoryDigestInput(story, reports, { corrected, knownArticleIds: last?.article_ids });
  const latest = reports[reports.length - 1]!.title;
  let written: { title: string; digest: string; citations: DigestSentence[] | null; receiptId: number | null };
  if (!opts.rewrite && last?.inputs_hash === inputsHash) {
    // A withdrawal clears the public projection but retains its history. Restoring exactly the same
    // evidence reuses that digest through the normal version/input checks, without another model call.
    written = { title: "", digest: last.digest, citations: last.citations, receiptId: last.receipt_id };
  } else {
    const res = await chatJson({
      model: await modelFor("digest"), purpose: "story_digest", subject: `story:${storyId}@${ids.length}`, promptVersion: DIGEST_PROMPT_VERSION,
      system: DIGEST_SYSTEM, user, schema: DigestSchema, ...DIGEST_SAMPLING,
    });
    const { kept } = citedSentences(res.data.sentences, listedReports(reports).listed);
    const digest = digestText(kept);
    if ([...digest].length < DIGEST_MIN_CHARS) {
      // The answer stays reusable: the same request is not paid for again.
      if (res.receiptId !== null) await completeReceipt(sql, res.receiptId);
      return { updated: false, tooShort: true };
    }
    written = { title: res.data.title, digest, citations: kept, receiptId: res.receiptId };
  }
  const version = story.version + 1;
  const updated = await sql.begin(async (tx) => {
    const [current] = await tx<{ version: number; merged_into: number | null }[]>`
      SELECT version, merged_into FROM stories WHERE id = ${storyId} FOR UPDATE`;
    // Report corrections, withdrawals and membership changes do not necessarily bump the story
    // version. Compare the same input identity again after the model returns.
    if (!current || current.version !== story.version || current.merged_into !== null || digestInputsHash(await digestReports(tx, [storyId])) !== inputsHash) {
      // A paid response remains reusable even when an editor or another digest won the race.
      if (written.receiptId !== null) await completeReceipt(tx, written.receiptId);
      return false;
    }
    await tx`INSERT INTO story_digests (story_id, version, digest, latest, receipt_id, article_ids, inputs_hash, citations)
             VALUES (${storyId}, ${version}, ${written.digest}, ${latest}, ${written.receiptId}, ${ids}, ${inputsHash}, ${written.citations === null ? null : tx.json(written.citations as never)})`;
    await tx`UPDATE stories SET digest = ${written.digest}, latest = ${latest}, digest_updated_at = now(),
               title = CASE WHEN origin = 'manual' OR ${written.title} = '' THEN title ELSE ${written.title} END,
               version = ${version}, updated_at = now()
             WHERE id = ${storyId}`;
    if (written.receiptId !== null) await completeReceipt(tx, written.receiptId);
    return true;
  });
  return updated ? { updated: true, version } : { updated: false };
}
