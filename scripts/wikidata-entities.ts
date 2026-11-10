// Suggests Wikidata items for the vocabulary's companies (industry/taxonomy.ts ENTITIES). It only prints and
// never writes: which item a company is, and which names it goes by, are the owner's to decide and copy into
// taxonomy.ts by hand.
// - A company with `wikidata`: the item's Chinese and English labels and aliases that none of the company's
//   names (name, aliases, orgNames, otherNames) has yet, compared as entityIdentity compares them.
// - A company without: the items Wikidata's search (wbsearchentities) finds for its name, the parts of a name
//   written as "A / B", and its first organisation name, each with Wikidata's own description to check it by.
//   node --use-system-ca scripts/wikidata-entities.ts [--entity <id>] [--limit 3]
// Reads only Wikidata's public API (no key, no database). Behind TLS interception Node needs --use-system-ca.
import { parseArgs } from "node:util";
import { SITE } from "@aihot/site";
import { ENTITIES, entityNames, nameKey } from "@aihot/backend/editorial/vocabulary";

const { values } = parseArgs({ options: { entity: { type: "string" }, limit: { type: "string", default: "3" } } });
const limit = Math.max(1, Math.min(10, Number(values.limit) || 3));
const API = "https://www.wikidata.org/w/api.php";
// Wikimedia asks every client to say who it is; the site's crawler name and address, not a person's.
const USER_AGENT = `${SITE.crawlerName} wikidata-entities (+${process.env.SITE_URL || SITE.defaultUrl})`;
const LANGUAGES = ["zh", "zh-hans", "zh-cn", "en"];

type Entity = (typeof ENTITIES)[string];
interface Term { language: string; value: string }
interface Item { id: string; missing?: string; labels?: Record<string, Term>; aliases?: Record<string, Term[]> }
interface Found { id: string; label?: string; description?: string }

async function api<T>(params: Record<string, string>): Promise<T> {
  const res = await fetch(`${API}?${new URLSearchParams({ ...params, format: "json", formatversion: "2" })}`, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Wikidata answered ${res.status} to ${params.action}`);
  return (await res.json()) as T;
}

const chinese = (s: string) => /\p{Script=Han}/u.test(s);

/** The item's zh/en labels and aliases the company is not yet known by. */
function newNames(id: string, e: Entity, item: Item): Term[] {
  const known = new Set([id, ...entityNames(e)].map(nameKey));
  const terms = [...Object.values(item.labels ?? {}), ...Object.values(item.aliases ?? {}).flat()];
  const seen = new Set<string>();
  return terms.filter((t) => {
    const k = nameKey(t.value);
    if (known.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function candidates(e: Entity): Promise<Array<Found & { query: string }>> {
  const parts = e.name.includes("/") ? e.name.split("/").map((s) => s.trim()) : [];
  const queries = [...new Set([e.name, ...parts, ...(e.orgNames ?? e.aliases).slice(0, 1)])].filter(Boolean);
  const found = new Map<string, Found & { query: string }>();
  for (const query of queries) {
    const language = chinese(query) ? "zh" : "en";
    const res = await api<{ search?: Found[] }>({ action: "wbsearchentities", search: query, language, uselang: language, type: "item", limit: String(limit) });
    for (const f of res.search ?? []) if (!found.has(f.id)) found.set(f.id, { ...f, query });
  }
  return [...found.values()];
}

const chosen = Object.entries(ENTITIES).filter(([id]) => !values.entity || id === values.entity);
if (!chosen.length) throw new Error(`no entity ${values.entity} in industry/taxonomy.ts`);

const mapped = chosen.filter(([, e]) => e.wikidata);
const items = new Map<string, Item>();
for (let i = 0; i < mapped.length; i += 50) {
  const ids = mapped.slice(i, i + 50).map(([, e]) => e.wikidata!);
  const res = await api<{ entities: Record<string, Item> }>({ action: "wbgetentities", ids: ids.join("|"), props: "labels|aliases", languages: LANGUAGES.join("|") });
  for (const [qid, item] of Object.entries(res.entities)) items.set(qid, item);
}

for (const [id, e] of chosen) {
  if (e.wikidata) {
    const item = items.get(e.wikidata);
    console.log(`${id}  ${e.name}  ${e.wikidata}`);
    if (!item || item.missing !== undefined) {
      console.log("  Wikidata 上没有这个条目，检查编号。");
      continue;
    }
    const names = newNames(id, e, item);
    console.log(names.length ? names.map((t) => `  ${t.language}  ${t.value}`).join("\n") : "  名字都已收录。");
    continue;
  }
  console.log(`${id}  ${e.name}  （没有 wikidata）`);
  // Wikidata is slow at times: one company's failed search is reported, and the others still run.
  const found = await candidates(e).catch((error: Error) => error);
  if (found instanceof Error) {
    console.log(`  这次没查到（${found.message}），稍后用 --entity ${id} 再试。`);
    continue;
  }
  console.log(found.length
    ? found.map((f) => `  ${f.id}  ${f.label ?? ""}${f.description ? ` — ${f.description}` : ""}  [搜 “${f.query}”]`).join("\n")
    : "  没有找到候选。");
}
