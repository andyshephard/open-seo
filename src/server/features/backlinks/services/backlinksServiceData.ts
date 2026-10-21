import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CreditFeature } from "@/shared/billing-credit-features";
import {
  RESEARCH_FRESHNESS_SECONDS,
  type CacheFreshness,
} from "@/server/lib/r2-cache";
import { readArchivedView } from "@/server/features/research-history/services/researchArchive";
import { archiveBacklinks, recordBacklinkSummary } from "./backlinksHistory";
import {
  buildBacklinksDateRange,
  buildOverviewResult,
} from "./backlinksOverviewResult";
import {
  createDataforseoClient,
  normalizeBacklinksTarget,
} from "@/server/lib/dataforseo";
import type {
  BacklinksLookupInput,
  BacklinksRowsPageInput,
  BacklinksSpamFilterOptions,
  ReferringDomainsPageInput,
  TopPagesPageInput,
} from "@/types/schemas/backlinks";

import {
  backlinksOverviewSchema,
  backlinksRowsPageResultSchema,
  referringDomainsPageResultSchema,
  topPagesPageResultSchema,
  type BacklinksOverviewResult,
  type BacklinksRowsPageResult,
  type ReferringDomainsPageResult,
  type TopPagesPageResult,
} from "@/server/features/backlinks/services/backlinksOverviewSchema";
import {
  buildBacklinksRowsApiFilters,
  buildBacklinksRowsOrderBy,
  buildReferringDomainsApiFilters,
  buildReferringDomainsOrderBy,
  buildTopPagesApiFilters,
  buildTopPagesOrderBy,
} from "@/server/features/backlinks/services/backlinksApiFilters";
import {
  buildBacklinksScopeFilter,
  countExpressionConditions,
  prependScopeClauses,
} from "@/server/lib/dataforseo/researchScopeFilters";
import { buildSubfolderOverview } from "@/server/features/backlinks/services/backlinksSubfolderOverview";
import {
  buildPageResult,
  mapBacklinksRows,
  mapReferringDomainsRows,
  mapTopPagesRows,
} from "@/server/features/backlinks/services/backlinksRowMappers";
import { assertFilterConditionBudget } from "@/server/lib/dataforseo/filters";
import { AppError } from "@/server/lib/errors";

// The page-request schemas carry projectId for the web middleware; the
// service layer is organization-scoped and never reads it.
export type BacklinksRowsPageServiceInput = Omit<
  BacklinksRowsPageInput,
  "projectId"
>;
export type ReferringDomainsPageServiceInput = Omit<
  ReferringDomainsPageInput,
  "projectId"
>;
export type TopPagesPageServiceInput = Omit<TopPagesPageInput, "projectId">;

const BACKLINKS_OVERVIEW_TTL_SECONDS = RESEARCH_FRESHNESS_SECONDS.backlinks;
const BACKLINKS_TAB_TTL_SECONDS = RESEARCH_FRESHNESS_SECONDS.backlinks;

const backlinksOverviewCacheSchema = z.object({
  overview: backlinksOverviewSchema,
});

export type BacklinksCache = {
  get(key: string, freshness?: CacheFreshness): Promise<unknown>;
  set(key: string, data: unknown, ttlSeconds: number): Promise<void>;
};

export async function profileBacklinksOverview(
  cache: BacklinksCache,
  cacheKey: string,
  input: BacklinksLookupInput,
  billingCustomer: BillingCustomerContext,
  creditFeature?: CreditFeature,
): Promise<{ overview: BacklinksOverviewResult }> {
  if (input.asOf)
    return backlinksOverviewCacheSchema.parse(
      await readArchivedView(billingCustomer, cacheKey, input.asOf),
    );
  const cached = backlinksOverviewCacheSchema.safeParse(
    await cache.get(cacheKey, input),
  );
  if (cached.success) {
    await recordBacklinkSummary(billingCustomer, cached.data.overview);
    await archiveBacklinks(billingCustomer, {
      kind: "backlinks_overview",
      viewKey: cacheKey,
      input,
      fetchedAt: cached.data.overview.fetchedAt,
      payload: cached.data,
    });
    return {
      overview: cached.data.overview,
    };
  }

  const dataforseo = createDataforseoClient(billingCustomer);

  const now = new Date();
  const normalizedTarget = normalizeBacklinksTarget(input.target, {
    scope: input.scope,
  });

  if (normalizedTarget.scope === "subfolder") {
    const overview = await buildSubfolderOverview(
      dataforseo,
      normalizedTarget,
      now,
      creditFeature,
    );
    await cacheValue(
      cache,
      cacheKey,
      { overview },
      BACKLINKS_OVERVIEW_TTL_SECONDS,
    );
    await archiveBacklinks(billingCustomer, {
      kind: "backlinks_overview",
      viewKey: cacheKey,
      input,
      fetchedAt: overview.fetchedAt,
      payload: { overview },
    });
    return { overview };
  }

  const dateRange = buildBacklinksDateRange(now);

  const [summary, history] = await Promise.all([
    dataforseo.backlinks.summary({
      target: normalizedTarget.apiTarget,
      includeSubdomains: normalizedTarget.includeSubdomains,
      creditFeature,
    }),
    // history/live only accepts a hostname and has no include_subdomains field,
    // so trends are unavailable for a page and subdomain-inclusive otherwise.
    normalizedTarget.scope === "exact_url"
      ? Promise.resolve([])
      : dataforseo.backlinks.history({
          target: normalizedTarget.apiTarget,
          ...dateRange,
          creditFeature,
        }),
  ]);

  const overview = buildOverviewResult({
    normalizedTarget,
    now,
    summary,
    history,
  });
  await cacheValue(
    cache,
    cacheKey,
    { overview },
    BACKLINKS_OVERVIEW_TTL_SECONDS,
  );
  await recordBacklinkSummary(billingCustomer, overview);
  await archiveBacklinks(billingCustomer, {
    kind: "backlinks_overview",
    viewKey: cacheKey,
    input,
    fetchedAt: overview.fetchedAt,
    payload: { overview },
  });

  return { overview };
}

export async function profileBacklinksRowsPage(
  cache: BacklinksCache,
  cacheKey: string,
  input: BacklinksRowsPageServiceInput,
  billingCustomer: BillingCustomerContext,
  spamOptions?: BacklinksSpamFilterOptions,
): Promise<BacklinksRowsPageResult> {
  if (input.asOf)
    return backlinksRowsPageResultSchema.parse(
      await readArchivedView(billingCustomer, cacheKey, input.asOf),
    );
  const cached = backlinksRowsPageResultSchema.safeParse(
    await cache.get(cacheKey, input),
  );
  if (cached.success) {
    await archiveBacklinks(billingCustomer, {
      kind: "backlinks_rows",
      viewKey: cacheKey,
      input,
      fetchedAt: cached.data.fetchedAt,
      payload: cached.data,
    });
    return cached.data;
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  const offset = (input.page - 1) * input.pageSize;

  const target = normalizeBacklinksTarget(input.target, { scope: input.scope });
  const scopeFilter = buildBacklinksScopeFilter("url_to", target);
  const userFilters = buildBacklinksRowsApiFilters(input.filters);
  // The scope group and the server-appended spam condition share the same
  // 8-condition budget as user filters.
  assertFilterConditionBudget(
    scopeFilter.conditionCount +
      countExpressionConditions(userFilters) +
      ((spamOptions?.hideSpam ?? true) ? 2 : 0),
  );
  const filters = prependScopeClauses(scopeFilter, userFilters);

  const response = await dataforseo.backlinks.rows({
    target: target.apiTarget,
    includeSubdomains: target.includeSubdomains,
    limit: input.pageSize,
    offset,
    orderBy: buildBacklinksRowsOrderBy(input.sortField, input.sortOrder),
    filters: filters.length > 0 ? filters : undefined,
    mode: input.mode,
    ...spamOptions,
  });

  const result = buildPageResult(input, offset, {
    rows: mapBacklinksRows(response.items),
    totalCount: response.totalCount,
  });
  await cacheValue(cache, cacheKey, result, BACKLINKS_TAB_TTL_SECONDS);
  await archiveBacklinks(billingCustomer, {
    kind: "backlinks_rows",
    viewKey: cacheKey,
    input,
    fetchedAt: result.fetchedAt,
    payload: result,
  });

  return result;
}

export async function profileReferringDomainsPage(
  cache: BacklinksCache,
  cacheKey: string,
  input: ReferringDomainsPageServiceInput,
  billingCustomer: BillingCustomerContext,
  spamOptions?: BacklinksSpamFilterOptions,
): Promise<ReferringDomainsPageResult> {
  if (input.asOf)
    return referringDomainsPageResultSchema.parse(
      await readArchivedView(billingCustomer, cacheKey, input.asOf),
    );
  const cached = referringDomainsPageResultSchema.safeParse(
    await cache.get(cacheKey, input),
  );
  if (cached.success) {
    await archiveBacklinks(billingCustomer, {
      kind: "backlinks_referring_domains",
      viewKey: cacheKey,
      input,
      fetchedAt: cached.data.fetchedAt,
      payload: cached.data,
    });
    return cached.data;
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  const offset = (input.page - 1) * input.pageSize;
  const filters = buildReferringDomainsApiFilters(input.filters);

  const target = normalizeBacklinksTarget(input.target, { scope: input.scope });
  // referring_domains has no URL field to filter on, so subfolder scope has no
  // accurate source for this breakdown (the count still comes from the
  // overview's filtered totals).
  if (target.scope === "subfolder") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Referring domains can't be broken down for a subfolder — use the Backlinks tab, or switch to Domain or Subdomains scope.",
    );
  }

  const response = await dataforseo.backlinks.referringDomains({
    target: target.apiTarget,
    includeSubdomains: target.includeSubdomains,
    limit: input.pageSize,
    offset,
    orderBy: buildReferringDomainsOrderBy(input.sortField, input.sortOrder),
    filters: filters.length > 0 ? filters : undefined,
    ...spamOptions,
  });

  const result = buildPageResult(input, offset, {
    rows: mapReferringDomainsRows(response.items),
    totalCount: response.totalCount,
  });
  await cacheValue(cache, cacheKey, result, BACKLINKS_TAB_TTL_SECONDS);
  await archiveBacklinks(billingCustomer, {
    kind: "backlinks_referring_domains",
    viewKey: cacheKey,
    input,
    fetchedAt: result.fetchedAt,
    payload: result,
  });

  return result;
}

export async function profileTopPagesPage(
  cache: BacklinksCache,
  cacheKey: string,
  input: TopPagesPageServiceInput,
  billingCustomer: BillingCustomerContext,
): Promise<TopPagesPageResult> {
  if (input.asOf)
    return topPagesPageResultSchema.parse(
      await readArchivedView(billingCustomer, cacheKey, input.asOf),
    );
  const cached = topPagesPageResultSchema.safeParse(
    await cache.get(cacheKey, input),
  );
  if (cached.success) {
    await archiveBacklinks(billingCustomer, {
      kind: "backlinks_top_pages",
      viewKey: cacheKey,
      input,
      fetchedAt: cached.data.fetchedAt,
      payload: cached.data,
    });
    return cached.data;
  }

  const dataforseo = createDataforseoClient(billingCustomer);
  const offset = (input.page - 1) * input.pageSize;

  const target = normalizeBacklinksTarget(input.target, { scope: input.scope });
  const scopeFilter = buildBacklinksScopeFilter("url", target);
  const userFilters = buildTopPagesApiFilters(input.filters);
  assertFilterConditionBudget(
    scopeFilter.conditionCount + countExpressionConditions(userFilters),
  );
  const filters = prependScopeClauses(scopeFilter, userFilters);

  const response = await dataforseo.backlinks.domainPages({
    target: target.apiTarget,
    includeSubdomains: target.includeSubdomains,
    limit: input.pageSize,
    offset,
    orderBy: buildTopPagesOrderBy(input.sortField, input.sortOrder),
    filters: filters.length > 0 ? filters : undefined,
  });

  const result = buildPageResult(input, offset, {
    rows: mapTopPagesRows(response.items),
    totalCount: response.totalCount,
  });
  await cacheValue(cache, cacheKey, result, BACKLINKS_TAB_TTL_SECONDS);
  await archiveBacklinks(billingCustomer, {
    kind: "backlinks_top_pages",
    viewKey: cacheKey,
    input,
    fetchedAt: result.fetchedAt,
    payload: result,
  });

  return result;
}

async function cacheValue(
  cache: BacklinksCache,
  key: string,
  data: unknown,
  ttlSeconds: number,
) {
  await cache.set(key, data, ttlSeconds).catch((error: unknown) => {
    console.error("backlinks.cache-write failed:", error);
  });
}
