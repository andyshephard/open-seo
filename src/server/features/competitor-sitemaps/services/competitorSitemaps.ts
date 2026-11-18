import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";
import {
  archiveLookup,
  readArchivedView,
} from "@/server/features/research-history/services/researchArchive";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import { AppError } from "@/server/lib/errors";
import { publicFetch } from "@/server/lib/public-fetch";
import { buildCacheKey } from "@/server/lib/r2-cache";
import {
  diffSnapshots,
  groupByFirstSegment,
  normalizeSitemapUrl,
  parseRobotsSitemaps,
  parseSitemapXml,
  recentlyModified,
  type SnapshotUrl,
} from "../sitemapParsing";

// Fetches a competitor's sitemaps, stores a snapshot of every URL with its
// lastmod in the research archive (kind sitemap_snapshot: project-scoped, kept
// 13 months, deleted with the project), and diffs it against the previous one.
// No DataForSEO calls. Every fetch is validated against the SSRF policy and
// goes through publicFetch (the crawl gateway in the standalone edition).

export const MAX_COMPETITOR_DOMAINS = 10;
const MAX_URLS = 50_000;
const MAX_SITEMAPS = 100;
const MAX_DEPTH = 3;
const FETCH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
// Sitemaps are capped at 50 MB uncompressed by the protocol; allow some slack.
const MAX_COMPRESSED_BYTES = 5_000_000;
const MAX_TEXT_BYTES = 10_000_000;
// Domains collected at once, on top of FETCH_CONCURRENCY sitemaps within each.
const DOMAIN_CONCURRENCY = 2;
// MCP clients wait about 60 s, so the whole call stops collecting before.
const CALL_BUDGET_MS = 45_000;
const LISTED_NEW = 200;
const LISTED_OTHER = 100;
const USER_AGENT = "OpenSEO-Sitemaps/1.0 (+https://openseo.so)";

const snapshotSchema = z.object({
  fetchedAt: z.string(),
  truncated: z.boolean(),
  urls: z.array(z.tuple([z.string(), z.string().nullable()])),
});

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Plain-text body of a URL, unzipping .gz sitemaps. Null when unavailable. */
async function fetchSitemapText(startUrl: string): Promise<string | null> {
  let current: string;
  try {
    current = await normalizeAndValidateStartUrl(startUrl);
  } catch {
    return null;
  }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await publicFetch(current, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/xml,text/*,*/*",
        },
        // Manual so every hop is re-validated against the SSRF policy.
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok && response.body) {
        const bytes = await readCapped(response.body, MAX_COMPRESSED_BYTES);
        if (!bytes) return null;
        const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
        const text = gzipped
          ? await readCapped(
              new Blob([new Uint8Array(bytes)])
                .stream()
                .pipeThrough(new DecompressionStream("gzip")),
              MAX_TEXT_BYTES,
            )
          : bytes;
        return text ? new TextDecoder().decode(text) : null;
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (response.status < 300 || response.status >= 400 || !location)
        return null;
      current = await normalizeAndValidateStartUrl(
        new URL(location, current).toString(),
      );
    }
  } catch {
    // Timeouts, TLS and network errors, and a blocked redirect: no sitemap.
  }
  return null;
}

function sameSite(url: string, domain: string) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

type Collection = {
  urls: Map<string, string | null>;
  seen: Set<string>;
  next: string[];
  truncated: boolean;
};

/** Files a parsed sitemap's entries: child sitemaps to fetch, or page URLs. */
function absorbSitemap(
  body: string,
  domain: string,
  state: Collection,
  deadline: number,
) {
  const parsed = parseSitemapXml(body, {
    // Entries still wanted: the rest of the URL budget (an index lists at most
    // MAX_SITEMAPS useful children).
    maxEntries: Math.max(MAX_URLS - state.urls.size, MAX_SITEMAPS),
    deadline,
  });
  if (parsed.truncated) state.truncated = true;
  for (const entry of parsed.entries) {
    if (parsed.kind === "index") {
      if (state.seen.has(entry.loc) || !sameSite(entry.loc, domain)) continue;
      state.seen.add(entry.loc);
      state.next.push(entry.loc);
      continue;
    }
    const key = normalizeSitemapUrl(entry.loc);
    if (!key || state.urls.has(key)) continue;
    if (state.urls.size >= MAX_URLS) {
      state.truncated = true;
      return;
    }
    state.urls.set(key, entry.lastmod);
  }
}

/** Every page URL the domain's sitemaps list, following indexes. */
async function collectDomainUrls(domain: string, deadline: number) {
  const origin = `https://${domain}`;
  const robots = await fetchSitemapText(`${origin}/robots.txt`);
  const roots = robots ? parseRobotsSitemaps(robots) : [];
  let level = (roots.length > 0 ? roots : [`${origin}/sitemap.xml`]).filter(
    (url) => sameSite(url, domain),
  );
  const state: Collection = {
    urls: new Map(),
    seen: new Set(level),
    next: [],
    truncated: false,
  };
  let fetched = 0;

  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    state.next = [];
    for (let i = 0; i < level.length; i += FETCH_CONCURRENCY) {
      if (Date.now() > deadline || fetched >= MAX_SITEMAPS) {
        state.truncated = true;
        break;
      }
      const batch = level.slice(i, i + FETCH_CONCURRENCY);
      fetched += batch.length;
      const bodies = await Promise.all(batch.map(fetchSitemapText));
      for (const body of bodies)
        if (body) absorbSitemap(body, domain, state, deadline);
    }
    if (depth === MAX_DEPTH && state.next.length > 0) state.truncated = true;
    level = state.next;
  }
  return {
    urls: Array.from(
      state.urls,
      ([url, lastmod]): SnapshotUrl => [url, lastmod],
    ),
    sitemapsFetched: fetched,
    truncated: state.truncated,
  };
}

async function readPreviousSnapshot(
  billing: BillingCustomerContext,
  viewKey: string,
) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const parsed = snapshotSchema.safeParse(
      await readArchivedView(billing, viewKey, today),
    );
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

async function snapshotDomain(
  rawDomain: string,
  sinceDays: number,
  billing: BillingCustomerContext,
  deadline: number,
) {
  if (Date.now() > deadline)
    return {
      domain: rawDomain,
      ok: false as const,
      error:
        "Skipped: the call's time budget ran out first. Call again with this domain.",
    };
  let domain: string;
  try {
    const url = await normalizeAndValidateStartUrl(rawDomain);
    domain = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return {
      domain: rawDomain,
      ok: false as const,
      error: "Not a public domain.",
    };
  }
  const now = Date.now();
  const collected = await collectDomainUrls(domain, deadline);
  if (collected.urls.length === 0)
    return {
      domain,
      ok: false as const,
      error:
        "No sitemap found: robots.txt lists none and /sitemap.xml is missing or empty.",
    };

  const viewKey = await buildCacheKey("sitemap:snapshot", { domain });
  const previous = await readPreviousSnapshot(billing, viewKey);
  const fetchedAt = new Date(now).toISOString();
  const snapshotStored = await archiveLookup(billing, {
    kind: "sitemap_snapshot",
    target: domain,
    viewKey,
    params: {},
    fetchedAt,
    payload: {
      fetchedAt,
      truncated: collected.truncated,
      sitemapsFetched: collected.sitemapsFetched,
      urls: collected.urls,
    },
  });

  const complete = !collected.truncated && !previous?.truncated;
  const notes: string[] = [];
  if (collected.truncated)
    notes.push(
      `Collection stopped early (limits: ${MAX_URLS} URLs, ${MAX_SITEMAPS} sitemaps, depth ${MAX_DEPTH}, ${CALL_BUDGET_MS / 1000}s per call), so URLs past it are missing and removals are not reported.`,
    );
  if (!complete && previous)
    notes.push(
      "Either this or the previous snapshot was cut short, so newUrls and refreshedUrls are partial (diffPartial): a URL missing from the earlier snapshot shows as new.",
    );
  if (!snapshotStored)
    notes.push(
      "The snapshot could not be stored, so the next run has no baseline.",
    );
  const diff = previous ? diffSnapshots(previous.urls, collected.urls) : null;
  const recent = recentlyModified(collected.urls, sinceDays, now);
  return {
    domain,
    ok: true as const,
    sitemapsFetched: collected.sitemapsFetched,
    totalUrls: collected.urls.length,
    urlsWithLastmod: collected.urls.filter(([, lastmod]) => lastmod).length,
    truncated: collected.truncated,
    firstRun: !previous,
    diffPartial: !!previous && !complete,
    previousSnapshotAt: previous?.fetchedAt ?? null,
    snapshotStored,
    recentlyModified: {
      sinceDays,
      count: recent.length,
      byPathSegment: groupByFirstSegment(recent),
    },
    newUrls: diff && {
      count: diff.added.length,
      byPathSegment: groupByFirstSegment(diff.added),
      urls: diff.added.slice(0, LISTED_NEW),
    },
    removedUrls:
      diff && complete
        ? {
            count: diff.removed.length,
            urls: diff.removed.slice(0, LISTED_OTHER),
          }
        : null,
    refreshedUrls: diff && {
      count: diff.refreshed.length,
      byPathSegment: groupByFirstSegment(diff.refreshed),
      urls: diff.refreshed.slice(0, LISTED_OTHER),
    },
    notes: previous
      ? notes
      : [
          "First snapshot for this domain: there is nothing to diff yet. recentlyModified shows what changed lately; run again later for new, removed and refreshed URLs.",
          ...notes,
        ],
  };
}

export async function diffCompetitorSitemaps(
  input: { projectId: string; domains?: string[]; sinceDays: number },
  billing: BillingCustomerContext,
) {
  const domains =
    input.domains ??
    (await ProjectContextService.getProjectContext(input.projectId)).competitors
      .map((competitor) => competitor.domain)
      .slice(0, MAX_COMPETITOR_DOMAINS);
  const deadline = Date.now() + CALL_BUDGET_MS;
  // A few domains at a time, so memory stays bounded (each holds its sitemaps).
  const results = [];
  for (let i = 0; i < domains.length; i += DOMAIN_CONCURRENCY) {
    results.push(
      ...(await Promise.all(
        domains
          .slice(i, i + DOMAIN_CONCURRENCY)
          .map((domain) =>
            snapshotDomain(domain, input.sinceDays, billing, deadline),
          ),
      )),
    );
  }
  return { domainsRequested: domains.length, results };
}
