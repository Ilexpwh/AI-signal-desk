// Story-digest evaluation cases, one event per JSONL line, written by hand or exported from the database
// (scripts/eval-story-digests.ts --stories); the site's digest input made from a case; what the site would
// publish of an answer; and the comparison a run writes, as Markdown for reading.
import { z } from "zod";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { byReportTime, citedSentences, DIGEST_MIN_CHARS, digestText, listedReports, type DroppedReason } from "@aihot/backend/events/digest";
import type { DigestReport, DigestSentence } from "@aihot/backend/publication/story-evidence";
import { parseCasesJsonl } from "./eval-tools.ts";

const ReportSchema = z.strictObject({
  id: z.string().min(1),
  publishedAt: z.iso.datetime({ offset: true }),
  source: z.string().min(1),
  firstParty: z.boolean().default(false),
  /** T1 or the fact subject's own verified account: each fact's earliest is its 首发. Defaults to firstParty. */
  firstHand: z.boolean().optional(),
  title: z.string().min(1),
  summary: z.string().nullable().default(null),
  fact: z.strictObject({
    id: z.number().int().positive(),
    subject: z.string().nullable().default(null),
    action: z.string().nullable().default(null),
    object: z.string().nullable().default(null),
    conditions: z.string().nullable().default(null),
    evidence: z.string().nullable().default(null),
    /** The analysis's structured fact: its conditions with source quotes, and its evidence. */
    structured: z.unknown().default(null),
  }),
});

const CaseSchema = z.strictObject({
  caseId: z.string().min(1),
  story: z.strictObject({
    title: z.string().min(1),
    previousDigest: z.string().nullable().default(null),
    /** The digest the event had when it was exported: shown beside the answers, never sent. */
    siteDigest: z.string().nullable().default(null),
  }),
  /**
   * incremental: the site's update, with previousDigest (if any) and the reports not in knownArticleIds
   * marked new; with neither, an event's first digest. corrected: rewritten from the reports as they are
   * now, without the previous digest, as after a correction.
   */
  inputMode: z.enum(["incremental", "corrected"]).default("incremental"),
  knownArticleIds: z.array(z.string().min(1)).default([]),
  reports: z.array(ReportSchema).min(1),
});

export type DigestEvalCase = z.infer<typeof CaseSchema>;

export const parseDigestEvalJsonl = (text: string): DigestEvalCase[] => parseCasesJsonl(text, CaseSchema);

/**
 * An event as the site rewrites its digest from its current reports (digestReports): without the
 * previous digest when it has saved one, the way a correction is rewritten; as a first digest otherwise.
 */
export function caseFromStory(story: { publicId: string; title: string; digest: string | null; hasDigest: boolean }, reports: DigestReport[]): DigestEvalCase {
  return {
    caseId: story.publicId,
    story: { title: story.title, previousDigest: null, siteDigest: story.digest },
    inputMode: story.hasDigest ? "corrected" : "incremental",
    knownArticleIds: [],
    reports: [...reports].sort(byReportTime).map((report) => ({
      id: report.id,
      publishedAt: report.at.toISOString(),
      source: report.source_name,
      firstParty: report.first_party,
      firstHand: report.first_hand,
      title: report.title,
      summary: report.summary,
      fact: {
        id: report.fact_id,
        subject: report.fact_subject,
        action: report.fact_action,
        object: report.fact_object,
        conditions: report.fact_conditions,
        evidence: report.evidence,
        structured: report.structured_fact ?? null,
      },
    })),
  };
}

/** The case as buildStoryDigestInput's arguments. */
export function toDigestInput(row: DigestEvalCase) {
  return {
    story: { title: row.story.title, digest: row.story.previousDigest },
    reports: row.reports.map((report): Omit<DigestReport, "story_id"> => ({
      id: report.id,
      title: report.title,
      summary: report.summary,
      source_name: report.source,
      first_party: report.firstParty,
      first_hand: report.firstHand ?? report.firstParty,
      at: new Date(report.publishedAt),
      fact_id: report.fact.id,
      fact_subject: report.fact.subject,
      fact_action: report.fact.action,
      fact_object: report.fact.object,
      fact_conditions: report.fact.conditions,
      evidence: report.fact.evidence,
      structured_fact: report.fact.structured,
    })).sort(byReportTime),
    corrected: row.inputMode === "corrected",
    knownArticleIds: row.knownArticleIds,
  };
}

export function inputForm(row: DigestEvalCase): string {
  if (row.inputMode === "corrected") return "更正后重写（不带上一版综述）";
  return row.story.previousDigest ? "增量更新（带上一版综述）" : "首次撰写";
}

/** What the site would make of an answer's sentences for this case (events/digest.ts): what it publishes and what it drops. */
export function publishedOf(row: DigestEvalCase, sentences: DigestSentence[]) {
  const { kept, dropped } = citedSentences(sentences, listedReports(toDigestInput(row).reports).listed);
  const digest = digestText(kept);
  return { kept, dropped, digest, published: [...digest].length >= DIGEST_MIN_CHARS };
}

export interface DigestCall {
  title: string | null;
  /** The sentences the site would publish, each with the reports it cites. */
  kept: DigestSentence[] | null;
  /** The sentences it would drop, and why. */
  dropped: Array<DigestSentence & { reason: DroppedReason }> | null;
  /** The kept sentences joined: the digest readers would get. */
  digest: string | null;
  /** Long enough to publish (DIGEST_MIN_CHARS); otherwise the event keeps its previous digest, or has none. */
  published: boolean;
  receiptId: number | null;
  reused: boolean;
  tokensIn: number;
  tokensOut: number;
  avgLatencyMs: number;
  error: string | null;
}

export interface DigestPromptSummary {
  calls: number;
  succeeded: number;
  errors: number;
  reused: number;
  /** Sentences the answers wrote, and those dropped, by reason. */
  sentences: number;
  dropped: Record<DroppedReason, number>;
  /** Answers too short to publish once their sentences were checked. */
  short: number;
  tokensIn: number;
  tokensOut: number;
  avgLatencyMs: number;
}

/** The sentence counts of a prompt's calls. */
export function sentenceCounts(calls: DigestCall[]): Pick<DigestPromptSummary, "sentences" | "dropped" | "short"> {
  const dropped: Record<DroppedReason, number> = { uncited: 0, unlisted: 0, unsupported: 0 };
  for (const sentence of calls.flatMap((call) => call.dropped ?? [])) dropped[sentence.reason] += 1;
  return {
    sentences: calls.reduce((n, call) => n + (call.kept?.length ?? 0) + (call.dropped?.length ?? 0), 0),
    dropped,
    short: calls.filter((call) => call.error === null && !call.published).length,
  };
}

/** What a run writes: per model, each case's call with the site's prompt beside the candidate's. */
export interface DigestEvalReport {
  meta: {
    createdAt: string;
    cases: string;
    calls: number;
    prompts: { live: { version: string }; candidate?: { file: string; version: string } };
  };
  models: Record<string, {
    summary: { live: DigestPromptSummary; candidate?: DigestPromptSummary; wallSeconds: number };
    cases: Array<{ caseId: string; storyTitle: string; input: string; reports: Array<{ id: string; publishedAt: string; source: string; title: string }>; siteDigest: string | null; live: DigestCall; candidate?: DigestCall }>;
  }>;
}

const PROMPTS = [["live", "线上提示词"], ["candidate", "候选提示词"]] as const;

const REASONS: Record<DroppedReason, string> = { uncited: "没有引用报道", unlisted: "引用了输入里没有的报道", unsupported: "数字、日期或名称在所引报道里找不到" };

const usage = (call: { receiptId: number | null; reused: boolean; tokensIn: number; tokensOut: number }) =>
  `${call.receiptId === null ? "无回执" : `回执 #${call.receiptId}`} · 输入 ${call.tokensIn} tokens · 输出 ${call.tokensOut} tokens${call.reused ? " · 复用已收到的结果" : ""}`;

const quoted = (text: string) => text.split("\n").map((line) => (line ? `> ${line}  ` : ">"));

/**
 * The report for reading: every case's reports numbered as its citations are, the event's current digest,
 * then each answer as the site would publish it, with its citations, and the sentences it would drop.
 */
export function digestComparisonMarkdown(report: DigestEvalReport): string {
  const { meta } = report;
  const lines = [
    "# 事件综述提示词对比",
    "",
    `- 生成时间：${meta.createdAt}`,
    `- 案例：${meta.cases}`,
    `- 线上提示词：${meta.prompts.live.version}`,
    ...(meta.prompts.candidate ? [`- 候选提示词：${meta.prompts.candidate.file}（${meta.prompts.candidate.version}）`] : []),
    `- 模型调用：${meta.calls} 次`,
  ];
  for (const [model, run] of Object.entries(report.models)) {
    for (const [key, label] of PROMPTS) {
      const summary = run.summary[key];
      if (!summary) continue;
      const reasons = (Object.keys(REASONS) as DroppedReason[]).map((reason) => `${REASONS[reason]} ${summary.dropped[reason]}`).join("、");
      lines.push(`- ${model} · ${label}：成功 ${summary.succeeded}/${summary.calls}，写了 ${summary.sentences} 句，不发布 ${Object.values(summary.dropped).reduce((a, b) => a + b, 0)} 句（${reasons}），${summary.short} 次检查后不足 ${DIGEST_MIN_CHARS} 字，输入 ${summary.tokensIn} tokens，输出 ${summary.tokensOut} tokens，${summary.reused} 次复用已收到的结果`);
    }
  }
  const runs = Object.entries(report.models);
  for (const [index, item] of (runs[0]?.[1].cases ?? []).entries()) {
    const numbers = new Map(item.reports.map((r, i) => [r.id, i + 1]));
    const marks = (ids: string[]) => `〔${ids.map((id) => numbers.get(id) ?? id).join("、")}〕`;
    lines.push("", `## ${index + 1}. ${item.storyTitle}`, "", `案例 \`${item.caseId}\` · 报道 ${item.reports.length} 篇 · ${item.input}`, "");
    for (const [i, r] of item.reports.entries()) lines.push(`${i + 1}. ${beijingDate(r.publishedAt)} ${beijingTime(r.publishedAt)} ${r.source}｜${r.title}（\`${r.id}\`）`);
    if (item.siteDigest) lines.push("", "### 事件现有的综述", "", ...quoted(item.siteDigest));
    for (const [model, run] of runs) {
      for (const [key, label] of PROMPTS) {
        const call = run.cases[index]![key];
        if (!call) continue;
        lines.push("", `### ${label} · ${model}`, "");
        if (call.error !== null || call.kept === null) {
          lines.push(`生成失败：${call.error}`);
        } else {
          const text = call.kept.map((s) => `${s.newParagraph ? "\n\n" : ""}${s.text}${marks(s.reports)}`).join("");
          lines.push(`**${call.title || "（沿用事件标题）"}**`, "", ...(text ? quoted(text) : ["（没有可发布的句子）"]));
          if (!call.published) lines.push("", `检查后不足 ${DIGEST_MIN_CHARS} 字，站点不发布这一版：事件保留上一版综述，没有的就不显示综述。`);
          if (call.dropped?.length) lines.push("", "不发布的句子：", ...call.dropped.map((s) => `- ${REASONS[s.reason]}${s.reports.length ? marks(s.reports) : ""}：${s.text}`));
        }
        lines.push("", usage(call));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
