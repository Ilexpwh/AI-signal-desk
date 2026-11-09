// Self-hosted browser renderer (Crawl4AI's POST /crawl at RENDER_URL): an article page the direct fetch
// could not read, rendered for free before paid Jina. Optional; without RENDER_URL nothing is sent.
import { z } from "zod";
import { credential } from "../config.ts";
import { assertEgressUrl } from "../lib/http-fetch.ts";
import { logError } from "../lib/log-error.ts";

/** One result of /crawl: the final status and address are those after redirects, the html the page as rendered. */
const CRAWL = z.object({
  results: z.array(z.object({
    success: z.boolean(),
    url: z.string(),
    html: z.string().nullish(),
    status_code: z.number().nullish(),
    redirected_url: z.string().nullish(),
    redirected_status_code: z.number().nullish(),
  })).min(1),
});

/**
 * The page at `url` as the renderer's browser left it, with the address it ended on; null without
 * RENDER_URL, for an address the fetcher would refuse, or when the page did not load with 200.
 * The renderer fetches the page itself, past guardedFetch: the address is checked before it is handed over
 * and the one the page ended on after, and the service has to run on a network that reaches nothing
 * internal (docs/deploy.md), since redirects and the page's own requests are made there. A service that
 * cannot be reached, refuses the request or answers something else is logged; either way the page is
 * left to the next fallback.
 */
export async function renderPage(url: string): Promise<{ html: string; url: string } | null> {
  const base = credential("collectors", "RENDER_URL");
  if (!base) return null;
  try { await assertEgressUrl(url); } catch { return null; }
  const token = credential("collectors", "RENDER_TOKEN");
  let page: z.infer<typeof CRAWL>["results"][number];
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/crawl`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ urls: [url], crawler_config: { type: "CrawlerRunConfig", params: { cache_mode: "bypass", page_timeout: 45_000 } } }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    // Crawl4AI 0.9 answers a page it could not load (a bot check, a download, its time limit) with 500 or 504.
    if (res.status === 500 || res.status === 504) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    page = CRAWL.parse(JSON.parse(text)).results[0]!;
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", msg: "render service failed", url, err: logError(error) }));
    return null;
  }
  const landed = page.redirected_url || page.url;
  if (!page.success || (page.redirected_status_code ?? page.status_code) !== 200 || !page.html) return null;
  try { await assertEgressUrl(landed); } catch { return null; }
  return { html: page.html, url: landed };
}
