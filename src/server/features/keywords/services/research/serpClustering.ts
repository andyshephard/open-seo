import { sort } from "remeda";
import { isGoogleRedirect } from "@/shared/google-serp-url";

// Keyword clustering by SERP URL overlap, to find keywords that Google answers
// with the same pages (and so should be served by one page, not two). Pure: the
// callers read the SERPs and hand them in.

const TOP_N = 10;
/** Shared top-10 URLs that put two keywords in the same cluster outright. */
const SAME_CLUSTER_SHARED = 3;
/** Shared URLs that cluster only when both SERPs have the same dominant type. */
const TYPE_GATED_SHARED = 2;

type SerpPageType =
  | "tool"
  | "listicle"
  | "docs"
  | "forum"
  | "video"
  | "product"
  | "blog";

export type SerpResultRow = {
  url: string | null;
  title: string | null;
  domain: string | null;
  /** The row's best organic position; rows are ordered by it. */
  position: number | null;
};

export type ClusterInput = {
  keyword: string;
  volume: number | null;
  results: SerpResultRow[];
};

type ClusterPage = {
  /** Normalized URL, or `domain :: title` when the SERP gave only a redirect. */
  key: string;
  type: SerpPageType;
};

type KeywordSerp = {
  keyword: string;
  volume: number | null;
  top: ClusterPage[];
  dominantType: SerpPageType;
  /** Own pages ranking anywhere in the SERP, by best position. */
  ownPages: { page: string; position: number | null }[];
};

type SerpCluster = {
  head: string;
  keywords: { keyword: string; volume: number | null }[];
  totalVolume: number;
  dominantType: SerpPageType;
  /** URLs of the head's top 10 that another member's top 10 also has. */
  sharedUrls: { url: string; keywordCount: number }[];
  /** The project's own pages ranking for this cluster's keywords. */
  ownPages: {
    page: string;
    keywords: { keyword: string; position: number | null }[];
  }[];
  /** 2+ distinct own pages rank within this cluster. */
  cannibalization: boolean;
  /** An own page here also ranks for keywords of another cluster. */
  split: boolean;
  splitPages: string[];
};

const FORUM_HOSTS = ["reddit.com", "quora.com", "stackoverflow.com"];
const TOOL_PATTERN =
  /\b(generator|calculator|checker|converter|maker|tools?|quiz|test|free online)\b/i;
const LISTICLE_TITLE_PATTERN = /^\s*\d+\+?\s|\b(best|top|alternatives)\b/i;
const DOCS_PATTERN = /\/(docs|help|support|api)(\/|$)/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hostMatches(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Lowercase host without www; no scheme, query, fragment or trailing slash. */
export function normalizeSerpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return null;
  }
}

export function classifySerpPageType(
  url: string | null,
  title: string | null,
): SerpPageType {
  const host = url ? hostOf(url) : null;
  let path = "";
  try {
    path = url ? new URL(url).pathname : "";
  } catch {
    path = "";
  }
  if (host && FORUM_HOSTS.some((forum) => hostMatches(host, forum)))
    return "forum";
  if (host && (hostMatches(host, "youtube.com") || host === "youtu.be"))
    return "video";
  if (DOCS_PATTERN.test(path)) return "docs";
  // A list of tools ("10 best quiz makers") is a listicle, not a tool.
  if (
    LISTICLE_TITLE_PATTERN.test(title ?? "") ||
    /\b(best|alternatives)\b/i.test(path)
  )
    return "listicle";
  if (TOOL_PATTERN.test(`${path.replaceAll("-", " ")} ${title ?? ""}`))
    return "tool";
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/pricing" || trimmed === "/features")
    return "product";
  return "blog";
}

/** The page type most of the top results share; ties go to the earlier row. */
function dominantType(pages: ClusterPage[]): SerpPageType {
  const counts = new Map<SerpPageType, number>();
  for (const page of pages)
    counts.set(page.type, (counts.get(page.type) ?? 0) + 1);
  let best: SerpPageType = "blog";
  let bestCount = 0;
  for (const page of pages) {
    const count = counts.get(page.type) ?? 0;
    if (count > bestCount) {
      best = page.type;
      bestCount = count;
    }
  }
  return best;
}

function pageKey(row: SerpResultRow): string | null {
  if (row.url && !isGoogleRedirect(row.url)) return normalizeSerpUrl(row.url);
  // A google.com/goto redirect hides the page URL; the same page keeps its
  // domain and title between SERPs, so that pair stands in for it.
  const domain = row.domain?.toLowerCase().replace(/^www\./, "");
  return domain && row.title
    ? `${domain} :: ${row.title.trim().toLowerCase()}`
    : null;
}

function buildSerp(input: ClusterInput, ownDomain: string | null): KeywordSerp {
  const ordered = sort(
    input.results,
    (a, b) =>
      (a.position ?? Number.MAX_SAFE_INTEGER) -
      (b.position ?? Number.MAX_SAFE_INTEGER),
  );
  const seen = new Set<string>();
  const unique: { row: SerpResultRow; key: string }[] = [];
  for (const row of ordered) {
    const key = pageKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({ row, key });
  }
  const top = unique.slice(0, TOP_N).map(({ row, key }) => ({
    key,
    type: classifySerpPageType(row.url, row.title),
  }));
  const ownPages = unique
    .filter(({ row }) => {
      const host =
        (row.url && !isGoogleRedirect(row.url) ? hostOf(row.url) : null) ??
        row.domain?.toLowerCase().replace(/^www\./, "") ??
        null;
      return !!ownDomain && !!host && hostMatches(host, ownDomain);
    })
    .map(({ row, key }) => ({ page: key, position: row.position }));
  return {
    keyword: input.keyword,
    volume: input.volume,
    top,
    dominantType: dominantType(top),
    ownPages,
  };
}

function sharedKeys(a: KeywordSerp, b: KeywordSerp): string[] {
  const other = new Set(b.top.map((page) => page.key));
  return a.top.map((page) => page.key).filter((key) => other.has(key));
}

function joinsCluster(serp: KeywordSerp, head: KeywordSerp): number | null {
  const shared = sharedKeys(serp, head).length;
  if (shared >= SAME_CLUSTER_SHARED) return shared;
  if (shared === TYPE_GATED_SHARED && serp.dominantType === head.dominantType)
    return shared;
  return null;
}

/**
 * Greedy clustering, biggest keyword first. A keyword is compared with each
 * cluster's head only, never its members, so a chain of loosely related SERPs
 * cannot pull unrelated keywords together. It joins the qualifying cluster it
 * shares the most URLs with. `ownDomain` marks the project's own pages.
 */
export function clusterKeywordsBySerp(
  inputs: ClusterInput[],
  ownDomain: string | null,
): SerpCluster[] {
  const normalizedOwn = ownDomain?.toLowerCase().replace(/^www\./, "") ?? null;
  const serps = sort(
    inputs.map((input) => buildSerp(input, normalizedOwn)),
    (a, b) =>
      (b.volume ?? 0) - (a.volume ?? 0) || a.keyword.localeCompare(b.keyword),
  );
  const groups: { head: KeywordSerp; members: KeywordSerp[] }[] = [];
  for (const serp of serps) {
    let target: (typeof groups)[number] | null = null;
    let targetShared = -1;
    for (const group of groups) {
      const shared = joinsCluster(serp, group.head);
      if (shared !== null && shared > targetShared) {
        target = group;
        targetShared = shared;
      }
    }
    if (target) target.members.push(serp);
    else groups.push({ head: serp, members: [serp] });
  }

  const clusters: SerpCluster[] = groups.map(({ head, members }) => {
    const urlCounts = new Map<string, number>();
    for (const page of head.top) urlCounts.set(page.key, 1);
    for (const member of members.slice(1)) {
      for (const key of sharedKeys(member, head))
        urlCounts.set(key, (urlCounts.get(key) ?? 1) + 1);
    }
    const ownPages = new Map<
      string,
      { keyword: string; position: number | null }[]
    >();
    for (const member of members) {
      for (const own of member.ownPages) {
        const list = ownPages.get(own.page) ?? [];
        list.push({ keyword: member.keyword, position: own.position });
        ownPages.set(own.page, list);
      }
    }
    return {
      head: head.keyword,
      keywords: members.map((m) => ({ keyword: m.keyword, volume: m.volume })),
      totalVolume: members.reduce((sum, m) => sum + (m.volume ?? 0), 0),
      dominantType: head.dominantType,
      sharedUrls:
        members.length > 1
          ? sort(
              [...urlCounts]
                .filter(([, count]) => count > 1)
                .map(([url, keywordCount]) => ({ url, keywordCount })),
              (a, b) =>
                b.keywordCount - a.keywordCount || a.url.localeCompare(b.url),
            )
          : [],
      ownPages: [...ownPages].map(([page, keywords]) => ({ page, keywords })),
      cannibalization: ownPages.size >= 2,
      split: false,
      splitPages: [],
    };
  });

  const clustersByPage = new Map<string, SerpCluster[]>();
  for (const cluster of clusters)
    for (const { page } of cluster.ownPages)
      clustersByPage.set(page, [...(clustersByPage.get(page) ?? []), cluster]);
  for (const [page, owners] of clustersByPage) {
    if (owners.length < 2) continue;
    for (const cluster of owners) {
      cluster.split = true;
      cluster.splitPages.push(page);
    }
  }
  return clusters;
}
