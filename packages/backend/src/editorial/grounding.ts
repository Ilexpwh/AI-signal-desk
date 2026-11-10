// Whether model-written text names only what its material names: a weekly or monthly's overview against its
// events (reports/compose.ts), a story digest's sentence against the reports it cites (events/digest.ts).
import { SITE } from "@aihot/site";
import { PLAIN_TERMS } from "@aihot/industry/taxonomy";
import { ENTITIES, entityNames } from "./vocabulary.ts";

const COMPANY_NAMES = Object.values(ENTITIES).map((e) => entityNames(e).map((n) => n.toLowerCase()));
/** Words a writer may use that name nothing in particular: the pack's plain terms and the site's name. */
const PLAIN = new Set([...PLAIN_TERMS, SITE.name.toLowerCase()]);

/**
 * Whether written text names only what the listed items name: every capitalised or numbered Latin token
 * (Acme, Nova-2.5, X1), every figure of three or more digits or with a decimal point or percent (845,
 * 129.3, 40%) and every company of the vocabulary appears in the items' own words; a company may be named
 * in either language (谷歌 for Google).
 */
export function grounded(text: string, corpus: string): boolean {
  const known = corpus.toLowerCase();
  const companies = COMPANY_NAMES.filter((names) => names.some((n) => known.includes(n)));
  const named = (word: string) => PLAIN.has(word) || known.includes(word) || companies.some((names) => names.includes(word));
  const words = (text.match(/[A-Za-z][A-Za-z0-9.+-]*/g) ?? []).map((w) => w.replace(/[.+-]+$/, "")).filter((w) => /[A-Z0-9]/.test(w));
  const figures = (text.match(/\d+(?:\.\d+)?%?/g) ?? []).filter((f) => f.length >= 3 || /[.%]/.test(f));
  const lower = text.toLowerCase();
  const mentioned = COMPANY_NAMES.filter((names) => names.some((n) => /\p{Script=Han}/u.test(n) && lower.includes(n)));
  return words.every((w) => named(w.toLowerCase())) && figures.every((f) => known.includes(f)) && mentioned.every((names) => companies.includes(names));
}
