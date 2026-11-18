import { sort } from "remeda";
// Parsing and diffing for XML sitemaps. Pure: fetching lives in the service.

type SitemapEntry = { loc: string; lastmod: string | null };

type ParsedSitemap = {
  kind: "index" | "urlset";
  entries: SitemapEntry[];
};

/** [url, lastmod] pairs, the compact form snapshots are stored in. */
export type SnapshotUrl = [string, string | null];

// A single entry is a few hundred bytes; anything bigger is junk or an attack.
const MAX_BLOCK_CHARS = 16_384;
const DEADLINE_CHECK_EVERY = 1000;

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

/**
 * Index of the next `<name` that is a whole tag name (followed by `>`, `/` or
 * whitespace), or -1. One indexOf per candidate, so it never rescans.
 */
function indexOfOpenTag(text: string, name: string, from: number): number {
  let at = text.indexOf(`<${name}`, from);
  while (at !== -1) {
    const next = text.charAt(at + name.length + 1);
    if (next === ">" || next === "/" || /\s/.test(next)) return at;
    at = text.indexOf(`<${name}`, at + 1);
  }
  return -1;
}

function tag(block: string, name: string): string | null {
  const open = indexOfOpenTag(block, name, 0);
  if (open === -1) return null;
  const start = block.indexOf(">", open);
  if (start === -1) return null;
  const end = block.indexOf(`</${name}`, start);
  if (end === -1) return null;
  return decodeXml(block.slice(start + 1, end)) || null;
}

/**
 * A sitemap index lists more sitemaps; a urlset lists pages. A linear scan:
 * each entry is found with indexOf from the end of the previous one, and an
 * entry with no closing tag ends the scan. Stops after `maxEntries` entries (the
 * result is then `truncated`) or once `deadline` (epoch ms) has passed.
 */
export function parseSitemapXml(
  xml: string,
  limits: { maxEntries?: number; deadline?: number } = {},
): ParsedSitemap & { truncated: boolean } {
  const maxEntries = limits.maxEntries ?? Number.POSITIVE_INFINITY;
  const kind = xml.includes("<sitemapindex") ? "index" : "urlset";
  const entryTag = kind === "index" ? "sitemap" : "url";
  const entries: SitemapEntry[] = [];
  let truncated = false;
  let position = 0;
  let scanned = 0;
  while (true) {
    const open = indexOfOpenTag(xml, entryTag, position);
    if (open === -1) break;
    const bodyStart = xml.indexOf(">", open);
    if (bodyStart === -1) break;
    const close = xml.indexOf(`</${entryTag}>`, bodyStart);
    if (close === -1) break;
    position = close + entryTag.length + 3;
    scanned += 1;
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    if (
      limits.deadline !== undefined &&
      scanned % DEADLINE_CHECK_EVERY === 0 &&
      Date.now() > limits.deadline
    ) {
      truncated = true;
      break;
    }
    if (close - bodyStart > MAX_BLOCK_CHARS) continue;
    const block = xml.slice(bodyStart + 1, close);
    const loc = tag(block, "loc");
    if (loc) entries.push({ loc, lastmod: tag(block, "lastmod") });
  }
  return { kind, entries, truncated };
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
