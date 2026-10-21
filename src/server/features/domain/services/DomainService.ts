import { waitUntil } from "cloudflare:workers";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { buildRankedKeywordsScopeFilter } from "@/server/lib/dataforseo/researchScopeFilters";
import { joinClauses } from "@/server/lib/dataforseo/filters";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";
import type { ResearchScope } from "@/shared/researchScope";
import { mapKeywordItem } from "@/server/features/domain/services/domainKeywordMapper";
import { getKeywordsPage } from "@/server/features/domain/services/domainKeywordsPage";
import { getPagesPage } from "@/server/features/domain/services/domainPagesPage";
import { captureDomainOverview } from "@/server/features/research-history/services/researchHistoryCapture";
import {
  archiveLookup,
  readArchivedView,
} from "@/server/features/research-history/services/researchArchive";

// Lets a caller attribute spend to its own feature (e.g. the SAM agent). Applied
// to the DataForSEO call, not the cache key, so cached results are shared
// across callers.
type MeteringOverrides = {
  creditFeature?: CreditFeature;
};

/** Domain overview data is refreshed every 12 hours. */
const DOMAIN_OVERVIEW_TTL_SECONDS = 12 * 60 * 60;

const domainOverviewResultSchema = z.object({
  domain: z.string(),
  organicTraffic: z.number().nullable(),
  organicKeywords: z.number().nullable(),
  backlinks: z.number().nullable(),
  referringDomains: z.number().nullable(),
  // Ranking-position buckets for research history; absent in older entries.
  top3Keywords: z.number().nullable().default(null),
  top10Keywords: z.number().nullable().default(null),
  hasData: z.boolean(),
  fetchedAt: z.string(),
});

const suggestedKeywordsSchema = z.array(
  z.object({
    keyword: z.string(),
    position: z.number().nullable(),
    searchVolume: z.number().nullable(),
    traffic: z.number().nullable(),
    cpc: z.number().nullable(),
    keywordDifficulty: z.number().nullable(),
  }),
);

type DomainOverviewResult = z.infer<typeof domainOverviewResultSchema> & {
  /** Requested research scope, echoed for display. */
  scope: ResearchScope;
  displayTarget: string;
};

async function getOverview(
  input: {
    projectId: string;
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
    asOf?: string;
  },
  billingCustomer: BillingCustomerContext,
  metering: MeteringOverrides = {},
): Promise<DomainOverviewResult> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);
  const domain = target.hostname;

  // domain_rank_overview has no filters and always covers the hostname plus
  // all of its subdomains, so every scope shares one cache entry per hostname.
  // Callers label the metrics as domain-wide for narrower scopes.
  const cacheKey = await buildCacheKey("domain:overview", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    domain,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
  });

  if (input.asOf)
    return {
      ...domainOverviewResultSchema.parse(
        await readArchivedView(billingCustomer, cacheKey, input.asOf),
      ),
      scope: target.scope,
      displayTarget: target.display,
    };

  const cachedRaw = await getCached(cacheKey);
  const cached = domainOverviewResultSchema.safeParse(cachedRaw);
  if (cached.success && cached.data.hasData) {
    await recordOverview(billingCustomer, input, cached.data);
    return {
      ...cached.data,
      scope: target.scope,
      displayTarget: target.display,
    };
  }

  const nowIso = new Date().toISOString();
  const dataforseo = createDataforseoClient(billingCustomer);

  const metricsResponse = await dataforseo.domain.rankOverview({
    target: domain,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    ...metering,
  });

  const metrics = metricsResponse[0];

  const organicTraffic =
    metrics?.metrics?.organic?.etv != null
      ? Math.round(metrics.metrics.organic.etv)
      : null;
  const organicKeywords =
    metrics?.metrics?.organic?.count != null
      ? Math.round(metrics.metrics.organic.count)
      : null;

  const organic = metrics?.metrics?.organic;
  const top3Keywords =
    organic != null ? (organic.pos_1 ?? 0) + (organic.pos_2_3 ?? 0) : null;

  const stored: z.infer<typeof domainOverviewResultSchema> = {
    domain,
    organicTraffic,
    organicKeywords,
    backlinks: null,
    referringDomains: null,
    top3Keywords,
    top10Keywords:
      top3Keywords != null ? top3Keywords + (organic?.pos_4_10 ?? 0) : null,
    hasData: organicKeywords != null && organicKeywords > 0,
    fetchedAt: nowIso,
  };

  if (stored.hasData) {
    // waitUntil, not void: workerd cancels unregistered pending I/O once the
    // response is sent, so a fire-and-forget put never persists the cache.
    waitUntil(
      setCached(cacheKey, stored, DOMAIN_OVERVIEW_TTL_SECONDS).catch(
        (error) => {
          console.error("domain.overview.cache-write failed:", error);
        },
      ),
    );
    await recordOverview(billingCustomer, input, stored);
    await archiveLookup(billingCustomer, {
      kind: "domain_overview",
      target: target.display,
      viewKey: cacheKey,
      params: {},
      market: input,
      fetchedAt: stored.fetchedAt,
      payload: stored,
    });
  }

  return { ...stored, scope: target.scope, displayTarget: target.display };
}

function recordOverview(
  billingCustomer: BillingCustomerContext,
  market: { locationCode: number; languageCode: string },
  overview: z.infer<typeof domainOverviewResultSchema>,
) {
  return captureDomainOverview(billingCustomer, {
    domain: overview.domain,
    locationCode: market.locationCode,
    languageCode: market.languageCode,
    organicTraffic: overview.organicTraffic,
    organicKeywords: overview.organicKeywords,
    top3Keywords: overview.top3Keywords,
    top10Keywords: overview.top10Keywords,
    fetchedAt: overview.fetchedAt,
  });
}

async function getSuggestedKeywords(
  input: {
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
    organizationId: string;
    projectId: string;
    asOf?: string;
  },
  billingCustomer: BillingCustomerContext,
  metering: MeteringOverrides = {},
): Promise<
  Array<{
    keyword: string;
    position: number | null;
    searchVolume: number | null;
    traffic: number | null;
    cpc: number | null;
    keywordDifficulty: number | null;
  }>
> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);
  const scopeFilter = buildRankedKeywordsScopeFilter(target);

  const cacheKey = await buildCacheKey("domain:keyword-suggestions", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    domain: target.hostname,
    scope: target.scope,
    path: target.path,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
  });

  if (input.asOf)
    return suggestedKeywordsSchema.parse(
      await readArchivedView(billingCustomer, cacheKey, input.asOf),
    );

  const cachedRaw = await getCached(cacheKey);
  const cached = suggestedKeywordsSchema.safeParse(cachedRaw);
  if (cached.success && cached.data.length > 0) {
    return cached.data;
  }

  const dataforseo = createDataforseoClient(billingCustomer);

  const rankedKeywordsResponse = await dataforseo.domain.rankedKeywords({
    target: target.hostname,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    limit: 100,
    orderBy: ["ranked_serp_element.serp_item.etv,desc"],
    filters:
      scopeFilter.clauses.length > 0
        ? joinClauses(scopeFilter.clauses, "and")
        : undefined,
    ...metering,
  });

  const keywords = rankedKeywordsResponse.items
    .map((item) => mapKeywordItem(item))
    .filter(
      (item): item is NonNullable<ReturnType<typeof mapKeywordItem>> =>
        item != null,
    )
    .map((item) => ({
      keyword: item.keyword,
      position: item.position,
      searchVolume: item.searchVolume,
      traffic: item.traffic,
      cpc: item.cpc,
      keywordDifficulty: item.keywordDifficulty,
    }));

  if (keywords.length > 0) {
    await archiveLookup(billingCustomer, {
      kind: "domain_keyword_suggestions",
      target: target.display,
      viewKey: cacheKey,
      params: { scope: target.scope },
      market: input,
      fetchedAt: new Date().toISOString(),
      payload: keywords,
    });
    waitUntil(
      setCached(cacheKey, keywords, DOMAIN_OVERVIEW_TTL_SECONDS).catch(
        (error) => {
          console.error(
            "domain.keyword-suggestions.cache-write failed:",
            error,
          );
        },
      ),
    );
  }

  return keywords;
}

export const DomainService = {
  getOverview,
  getSuggestedKeywords,
  getKeywordsPage,
  getPagesPage,
} as const;
