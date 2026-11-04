import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import {
  buildCacheKey,
  getCachedEntry,
  RESEARCH_FRESHNESS_SECONDS,
  setCached,
  type CacheFreshness,
} from "@/server/lib/r2-cache";
import {
  archiveLookup,
  archiveParams,
  readArchivedView,
} from "@/server/features/research-history/services/researchArchive";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";
import { buildRankedKeywordsScopeFilter } from "@/server/lib/dataforseo/researchScopeFilters";
import type { ResearchScope } from "@/shared/researchScope";
import { mapKeywordItem } from "@/server/features/domain/services/domainKeywordMapper";
import { computeHasMore } from "@/server/features/domain/services/pagination";
import {
  buildKeywordFilters,
  buildOrderBy,
  type DomainKeywordsSortMode,
  type DomainKeywordsSortOrder,
} from "@/server/features/domain/services/domainKeywordFilters";
import type { DomainKeywordsFilters } from "@/types/schemas/domain";

const domainKeywordsPageResultSchema = z.object({
  domain: z.string(),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number().nullable(),
  hasMore: z.boolean(),
  keywords: z.array(
    z.object({
      keyword: z.string(),
      position: z.number().nullable(),
      searchVolume: z.number().nullable(),
      traffic: z.number().nullable(),
      cpc: z.number().nullable(),
      url: z.string().nullable(),
      relativeUrl: z.string().nullable(),
      keywordDifficulty: z.number().nullable(),
    }),
  ),
  fetchedAt: z.string(),
});

type DomainKeywordsPageResult = z.infer<typeof domainKeywordsPageResultSchema>;

export async function getKeywordsPage(
  input: {
    projectId: string;
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
    page: number;
    pageSize: number;
    sortMode: DomainKeywordsSortMode;
    sortOrder: DomainKeywordsSortOrder;
    filters: DomainKeywordsFilters;
    search?: string;
    asOf?: string;
  } & CacheFreshness,
  billingCustomer: BillingCustomerContext,
): Promise<DomainKeywordsPageResult> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);
  const scopeFilter = buildRankedKeywordsScopeFilter(target);
  const offset = (input.page - 1) * input.pageSize;
  const orderBy = buildOrderBy(input.sortMode, input.sortOrder);
  const filters = buildKeywordFilters(input.filters, input.search, scopeFilter);

  const cacheKey = await buildCacheKey("domain:keywords-page", {
    organizationId: billingCustomer.organizationId,
    domain: target.hostname,
    scope: target.scope,
    path: target.path,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    page: input.page,
    pageSize: input.pageSize,
    sortMode: input.sortMode,
    sortOrder: input.sortOrder,
    // Empty filter fields mean "no filter" however a caller spells them, so
    // the app's views and snapshots share one entry.
    filters: Object.fromEntries(
      Object.entries(input.filters).filter(
        ([, value]) => value !== undefined && value !== "",
      ),
    ),
    search: input.search?.trim() || undefined,
  });

  if (input.asOf)
    return domainKeywordsPageResultSchema.parse(
      await readArchivedView(billingCustomer, cacheKey, input.asOf),
    );

  const archive = (result: { fetchedAt: string }) =>
    archiveLookup(billingCustomer, {
      kind: "domain_keywords",
      target: target.display,
      viewKey: cacheKey,
      params: archiveParams(input),
      market: input,
      fetchedAt: result.fetchedAt,
      payload: result,
    });

  const cached = domainKeywordsPageResultSchema.safeParse(
    (await getCachedEntry(cacheKey, input))?.value,
  );
  if (cached.success) {
    await archive(cached.data);
    return cached.data;
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  const response = await dataforseo.domain.rankedKeywords({
    target: target.hostname,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    limit: input.pageSize,
    offset,
    orderBy,
    filters: filters.length > 0 ? filters : undefined,
  });

  const keywords = response.items
    .map((item) => mapKeywordItem(item))
    .filter(
      (item): item is NonNullable<ReturnType<typeof mapKeywordItem>> =>
        item != null,
    );

  const totalCount = response.totalCount;
  const hasMore = computeHasMore(
    offset,
    response.items.length,
    totalCount,
    input.pageSize,
  );

  const result: DomainKeywordsPageResult = {
    domain: target.hostname,
    page: input.page,
    pageSize: input.pageSize,
    totalCount,
    hasMore,
    keywords,
    fetchedAt: new Date().toISOString(),
  };

  await archive(result);

  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(cacheKey, result, RESEARCH_FRESHNESS_SECONDS.domain).catch(
      (error) => {
        console.error("domain.keywords-page.cache-write failed:", error);
      },
    ),
  );

  return result;
}
