import { sort } from "remeda";
import { z } from "zod";
import { SERP_ANALYSIS_DEPTH } from "@/server/lib/dataforseo";
import { KeywordResearchService } from "@/server/features/keywords/services/KeywordResearchService";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";
import {
  clusterKeywordsBySerp,
  type ClusterInput,
} from "@/server/features/keywords/services/research/serpClustering";
import { getSerpSnapshot } from "@/server/features/keywords/services/research/serpSnapshot";
import {
  organicSerpRows,
  readStoredSerp,
} from "@/server/features/keywords/services/research/storedSerps";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import { toolErrorMessage } from "@/server/mcp/tool-error-message";
import { resolveMarket } from "@/shared/keyword-locations";

const MAX_KEYWORDS = 250;
const MAX_NEW_SERPS = 10;
const SAVED_PAGE_SIZE = 250;
const SAVED_PAGES = 4;
const LOOKUP_CONCURRENCY = 8;
// Matches get_serp_results: ~5 credits per keyword at the default depth.
const APPROX_CREDITS_PER_NEW_SERP = 5;

const inputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_KEYWORDS)
    .optional()
    .describe(
      `Up to ${MAX_KEYWORDS} keywords to cluster. Give this or savedKeywordTag.`,
    ),
  savedKeywordTag: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      `Cluster the project's saved keywords with this tag (up to ${MAX_KEYWORDS}, highest volume first). Give this or keywords.`,
    ),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  useCachedOnly: z
    .boolean()
    .default(true)
    .describe(
      "Default true: use only SERPs already stored for this project, and list the rest under skipped. Set false, with maxNewSerps, to buy missing SERPs.",
    ),
  maxNewSerps: z
    .number()
    .int()
    .min(0)
    .max(MAX_NEW_SERPS)
    .default(0)
    .describe(
      `Most SERPs to buy when useCachedOnly is false, highest volume first (max ${MAX_NEW_SERPS}). Default 0. Each costs about ${APPROX_CREDITS_PER_NEW_SERP} credits because a SERP is read 3 times and merged.`,
    ),
  maxAgeDays: z
    .number()
    .int()
    .min(1)
    .max(395)
    .default(90)
    .describe(
      "Only use stored SERPs at most this many days old. Default 90; older ones count as missing.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const clusterOutput = z.looseObject({
  head: z.string(),
  keywords: z.array(
    z.looseObject({ keyword: z.string(), volume: z.number().nullable() }),
  ),
  totalVolume: z.number(),
  dominantType: z.string(),
  sharedUrls: z.array(
    z.looseObject({ url: z.string(), keywordCount: z.number() }),
  ),
  ownPages: z.array(
    z.looseObject({
      page: z.string(),
      keywords: z.array(
        z.looseObject({
          keyword: z.string(),
          position: z.number().nullable(),
        }),
      ),
    }),
  ),
  cannibalization: z.boolean(),
  split: z.boolean(),
  splitPages: z.array(z.string()),
});

const outputSchema = z.looseObject({
  clusters: z.array(clusterOutput),
  skipped: z.array(z.looseObject({ keyword: z.string(), reason: z.string() })),
  summary: z.looseObject({
    keywords: z.number(),
    clustered: z.number(),
    skipped: z.number(),
    newSerpsBought: z.number(),
    approxCreditsToBuyAllSkipped: z.number(),
    oldestSerpFetchedAt: z.string().nullable(),
  }),
  ...optionalMetaOutputSchema,
});

function ownDomainOf(domain: string | null): string | null {
  if (!domain) return null;
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "");
  return host || null;
}

/** Runs `task` over `items`, at most `limit` at a time, keeping order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(
      ...(await Promise.all(items.slice(start, start + limit).map(task))),
    );
  }
  return results;
}

async function loadKeywords(args: Args) {
  if (!!args.keywords === !!args.savedKeywordTag)
    throw new AppError(
      "VALIDATION_ERROR",
      "Pass exactly one of keywords or savedKeywordTag.",
    );
  const volumes = new Map<string, number | null>();
  const tagged: string[] = [];
  let page = 1;
  // Saved keywords carry stored volume; keywords outside them cluster with
  // unknown volume (sorted last).
  for (; page <= SAVED_PAGES; page += 1) {
    const { rows, totalCount } = await KeywordResearchService.getSavedKeywords({
      projectId: args.projectId,
      tagNames: args.savedKeywordTag ? [args.savedKeywordTag] : undefined,
      page,
      pageSize: SAVED_PAGE_SIZE,
      sort: "searchVolume",
      order: "desc",
    });
    for (const row of rows) {
      volumes.set(normalizeKeyword(row.keyword), row.searchVolume);
      tagged.push(row.keyword);
    }
    if (page * SAVED_PAGE_SIZE >= totalCount) break;
    if (args.savedKeywordTag && tagged.length >= MAX_KEYWORDS) break;
  }
  const source = args.keywords ?? tagged;
  const unique = new Map(source.map((k) => [normalizeKeyword(k), k.trim()]));
  return {
    keywords: [...unique]
      .slice(0, MAX_KEYWORDS)
      .map(([key, keyword]) => ({ keyword, volume: volumes.get(key) ?? null })),
    tagMissing: !!args.savedKeywordTag && tagged.length === 0,
  };
}

function formatText(data: z.infer<typeof outputSchema>) {
  const lines = [
    `${data.summary.clustered} of ${data.summary.keywords} keywords clustered into ${data.clusters.length} clusters; ${data.summary.skipped} skipped.`,
  ];
  for (const cluster of data.clusters) {
    const flags = [
      cluster.cannibalization ? "CANNIBALIZATION" : "",
      cluster.split ? "SPLIT" : "",
    ].filter(Boolean);
    lines.push(
      `- ${cluster.head} (${cluster.keywords.length} kw, vol ${cluster.totalVolume}, ${cluster.dominantType})${flags.length ? ` [${flags.join(", ")}]` : ""}: ${cluster.keywords.map((k) => k.keyword).join("; ")}`,
    );
  }
  if (data.skipped.length) {
    lines.push(
      `Skipped (no stored SERP): ${data.skipped.map((s) => s.keyword).join("; ")}. Buying them all costs about ${data.summary.approxCreditsToBuyAllSkipped} credits: pass useCachedOnly false and maxNewSerps.`,
    );
  }
  return lines.join("\n");
}

export const clusterKeywordsBySerpTool = {
  name: "cluster_keywords_by_serp",
  config: {
    title: "Cluster keywords by SERP overlap",
    description:
      "Group keywords whose Google results share the same pages, so each group is served by one page instead of cannibalizing itself. Keywords go in one cluster when their top-10 URLs share 3+ pages, or 2 pages with the same dominant page type (tool, listicle, docs, forum, video, product, blog); each keyword is compared with a cluster's head only, so clusters do not chain. Each cluster lists its head (highest volume), keywords, total volume, dominant page type, shared URLs, which of the project's own pages rank for it, and flags: cannibalization (2+ own pages rank within one cluster; own pages count anywhere in the stored SERP, not only the top 10) and split (one own page ranks for keywords in 2+ clusters). By default it uses no credits: it reads SERPs OpenSEO already stored for the project in the last maxAgeDays and lists keywords without one under skipped. To buy missing SERPs set useCachedOnly false and maxNewSerps: each costs about 5 credits (a SERP is read 3 times and merged) and counts toward the spend cap; a large buy can outlast the client's wait, and calling again with the same arguments collects what finished at no extra charge. Volumes come from saved keywords. Give keywords or savedKeywordTag. Results behind a google.com/goto redirect are matched by domain and title.",
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const market = resolveMarket(args, context.project);
    const { keywords, tagMissing } = await loadKeywords(args);
    const clusterInputs: ClusterInput[] = [];
    const missing: { keyword: string; volume: number | null }[] = [];
    const fetchedAt: string[] = [];

    const stored = await mapLimited(keywords, LOOKUP_CONCURRENCY, (k) =>
      readStoredSerp({
        projectId: args.projectId,
        keyword: k.keyword,
        ...market,
        maxAgeDays: args.maxAgeDays,
      }),
    );
    keywords.forEach((k, index) => {
      const serp = stored[index];
      if (serp && serp.results.length > 0) {
        clusterInputs.push({ ...k, results: serp.results });
        fetchedAt.push(serp.fetchedAt);
      } else missing.push(k);
    });

    const skipped: { keyword: string; reason: string }[] = [];
    const toBuy = args.useCachedOnly
      ? []
      : sort(missing, (a, b) => (b.volume ?? 0) - (a.volume ?? 0)).slice(
          0,
          args.maxNewSerps,
        );
    const bought = await mapLimited(toBuy, 3, async (k) => {
      try {
        const snapshot = await getSerpSnapshot(
          { keyword: k.keyword, ...market, depth: SERP_ANALYSIS_DEPTH },
          context.billing,
        );
        return { k, snapshot };
      } catch (error) {
        return { k, error: toolErrorMessage(error) };
      }
    });
    const boughtKeys = new Set<string>();
    for (const result of bought) {
      boughtKeys.add(result.k.keyword);
      if (result.snapshot) {
        clusterInputs.push({
          ...result.k,
          results: organicSerpRows(result.snapshot.items),
        });
        fetchedAt.push(result.snapshot.fetchedAt);
      } else {
        skipped.push({
          keyword: result.k.keyword,
          reason: `Fetch failed: ${result.error}`,
        });
      }
    }
    for (const k of missing) {
      if (boughtKeys.has(k.keyword)) continue;
      skipped.push({
        keyword: k.keyword,
        reason: args.useCachedOnly
          ? "No stored SERP within maxAgeDays (useCachedOnly is true)."
          : "No stored SERP, and maxNewSerps was used up.",
      });
    }

    const clusters = clusterKeywordsBySerp(
      clusterInputs,
      ownDomainOf(context.project.domain),
    );
    const unbought = skipped.filter(
      (s) => !s.reason.startsWith("Fetch failed"),
    );
    const data = {
      clusters,
      skipped,
      summary: {
        keywords: keywords.length,
        clustered: clusterInputs.length,
        skipped: skipped.length,
        newSerpsBought: bought.filter((b) => b.snapshot).length,
        approxCreditsToBuyAllSkipped:
          unbought.length * APPROX_CREDITS_PER_NEW_SERP,
        oldestSerpFetchedAt:
          sort(fetchedAt, (a, b) => a.localeCompare(b))[0] ?? null,
      },
    };
    return mcpResponse({
      text: tagMissing
        ? `No saved keywords have the tag "${args.savedKeywordTag}".`
        : formatText(outputSchema.parse(data)),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/keywords`,
      ),
      structuredContent: data,
    });
  }),
};
