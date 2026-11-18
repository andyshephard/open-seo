import { sort } from "remeda";
// Parsing and diffing for XML sitemaps. Pure: fetching lives in the service.

type SitemapEntry = { loc: string; lastmod: string | null };

type ParsedSitemap = {
  kind: "index" | "urlset";
  entries: SitemapEntry[];
};

/** [url, lastmod] pairs, the compact form snapshots are stored in. */
export type SnapshotUrl = [string, string | null];

const BLOCK_PATTERN = /<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

function decodeXml(value: string): string {
  return value
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(
    `<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`,
    "i",
  ).exec(block);
  return match ? decodeXml(match[1]) || null : null;
}

/** A sitemap index lists more sitemaps; a urlset lists pages. */
export function parseSitemapXml(xml: string): ParsedSitemap {
  const kind = /<sitemapindex\b/i.test(xml) ? "index" : "urlset";
  const entries: SitemapEntry[] = [];
  for (const match of xml.matchAll(BLOCK_PATTERN)) {
    const loc = tag(match[2], "loc");
    if (loc) entries.push({ loc, lastmod: tag(match[2], "lastmod") });
  }
  return { kind, entries };
}

/** The `Sitemap:` lines of a robots.txt, in order, without duplicates. */
export function parseRobotsSitemaps(robots: string): string[] {
  const urls = robots
    .split(/\r?\n/)
    .map((line) => /^\s*sitemap\s*:\s*(\S+)/i.exec(line)?.[1])
    .filter((url): url is string => !!url);
  return [...new Set(urls)];
}

/** Lowercase host, no fragment, no trailing slash: the identity of a page. */
export function normalizeSitemapUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

function lastmodMs(lastmod: string | null): number | null {
  if (!lastmod) return null;
  const ms = Date.parse(lastmod);
  return Number.isNaN(ms) ? null : ms;
}

function lastmodChanged(before: string | null, after: string | null) {
  if (before === null || after === null) return false;
  const a = lastmodMs(before);
  const b = lastmodMs(after);
  return a !== null && b !== null ? a !== b : before !== after;
}

/** First path segment as "/blog/", or "/" for the root and top-level files. */
export function firstPathSegment(url: string): string {
  try {
    const [segment, ...rest] = new URL(url).pathname.split("/").filter(Boolean);
    return segment && rest.length > 0 ? `/${segment}/` : "/";
  } catch {
    return "/";
  }
}

export function groupByFirstSegment(urls: string[], sampleSize = 5) {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const segment = firstPathSegment(url);
    groups.set(segment, [...(groups.get(segment) ?? []), url]);
  }
  const rows = [...groups].map(([segment, members]) => ({
    segment,
    count: members.length,
    sample: members.slice(0, sampleSize),
  }));
  return sort(
    rows,
    (a, b) => b.count - a.count || a.segment.localeCompare(b.segment),
  );
}

/** URLs whose lastmod falls within `sinceDays` of `now`. */
export function recentlyModified(
  urls: SnapshotUrl[],
  sinceDays: number,
  now: number,
): string[] {
  const cutoff = now - sinceDays * 86_400_000;
  return urls.flatMap(([url, lastmod]) => {
    const ms = lastmodMs(lastmod);
    return ms !== null && ms >= cutoff ? [url] : [];
  });
}

export function diffSnapshots(previous: SnapshotUrl[], current: SnapshotUrl[]) {
  const before = new Map(previous);
  const after = new Map(current);
  const added: string[] = [];
  const refreshed: string[] = [];
  for (const [url, lastmod] of after) {
    if (!before.has(url)) added.push(url);
    else if (lastmodChanged(before.get(url) ?? null, lastmod))
      refreshed.push(url);
  }
  const removed = [...before.keys()].filter((url) => !after.has(url));
  return { added, removed, refreshed };
}
