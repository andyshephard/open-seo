import { unique } from "remeda";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { normalizeIntent } from "@/server/features/keywords/services/research/helpers";
import { archiveLookup } from "@/server/features/research-history/services/researchArchive";
import { captureKeywordMetrics } from "@/server/features/research-history/services/researchHistoryCapture";
import {
  createDataforseoClient,
  fetchKeywordMetricsForList,
  type KeywordMetricRow,
} from "@/server/lib/dataforseo";
import {
  buildCacheKey,
  RESEARCH_FRESHNESS_SECONDS,
  type CacheFreshness,
} from "@/server/lib/r2-cache";
import type { CreditFeature } from "@/shared/billing-credit-features";

// One way to get volume, difficulty and CPC for a keyword list, shared by the
// get_keyword_metrics MCP tool, the Saved Keywords refresh, scheduled
// snapshots and rank tracking. National metrics the project already holds
// (from any keyword research or refresh) are reused inside the freshness
// window; only the rest is bought, then stored for the next caller.

const monthlySearchesSchema = z
  .array(
    z.object({
      year: z.number(),
      month: z.number(),
      searchVolume: z.number(),
    }),
  )
  .catch([]);

function parseMonthlySearches(json: string | null) {
  if (!json) return [];
  try {
    return monthlySearchesSchema.parse(JSON.parse(json));
  } catch {
    return [];
  }
}

export async function getKeywordMetrics(
  input: {
    projectId: string;
    keywords: string[];
    locationCode: number;
    languageCode: string;
    creditFeature: CreditFeature;
    /** City or region: volumes are bought live, since stored rows are national. */
    locationName?: string;
    includeClickstreamData?: boolean;
  } & CacheFreshness,
  billingCustomer: BillingCustomerContext,
): Promise<KeywordMetricRow[]> {
  // The keyword-data APIs are case-insensitive and echo keywords lowercased.
  const keywords = unique(
    input.keywords.map((keyword) => keyword.trim().toLowerCase()),
  ).filter(Boolean);
  if (keywords.length === 0) return [];
  // Stored rows hold national, non-clickstream metrics only.
  const national = !input.locationName && !input.includeClickstreamData;

  const maxAgeSeconds =
    input.maxAgeDays != null
      ? input.maxAgeDays * 86400
      : RESEARCH_FRESHNESS_SECONDS.keywords;
  const stored =
    national && !input.refresh
      ? await KeywordResearchRepository.listStoredKeywordMetrics({
          projectId: input.projectId,
          keywords,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          since: new Date(Date.now() - maxAgeSeconds * 1000).toISOString(),
        })
      : [];
  const storedRows = new Map<string, KeywordMetricRow>(
    stored.map((row) => [
      row.keyword,
      {
        keyword: row.keyword,
        searchVolume: row.searchVolume,
        cpc: row.cpc,
        competition: row.competition,
        competitionLevel: null,
        keywordDifficulty: row.keywordDifficulty,
        intent: row.intent,
        monthlySearches: parseMonthlySearches(row.monthlySearches),
      },
    ]),
  );
  const missing = keywords.filter((keyword) => !storedRows.has(keyword));

  const fetched =
    missing.length > 0
      ? await fetchKeywordMetricsForList(
          createDataforseoClient(billingCustomer),
          {
            keywords: missing,
            locationCode: input.locationCode,
            languageCode: input.languageCode,
            locationName: input.locationName,
            includeClickstreamData: input.includeClickstreamData,
            creditFeature: input.creditFeature,
          },
        )
      : [];

  if (fetched.length > 0) {
    const market = {
      locationCode: input.locationCode,
      languageCode: input.languageCode,
    };
    await archiveLookup(billingCustomer, {
      kind: "keyword_metrics",
      target: missing.join(", "),
      viewKey: await buildCacheKey("keyword-metrics", {
        keywords: missing,
        ...market,
        locationName: input.locationName,
        includeClickstreamData: input.includeClickstreamData ?? false,
      }),
      params: {
        ...(input.locationName ? { locationName: input.locationName } : {}),
        ...(input.includeClickstreamData ? { clickstream: true } : {}),
      },
      market,
      fetchedAt: new Date().toISOString(),
      payload: fetched,
    });
    if (national) {
      await captureKeywordMetrics(input.projectId, {
        ...market,
        rows: fetched,
      });
      // Bounded concurrency: a list can hold thousands of keywords.
      for (let i = 0; i < fetched.length; i += 100) {
        await Promise.all(
          fetched.slice(i, i + 100).map((metric) =>
            KeywordResearchRepository.upsertKeywordMetric({
              projectId: input.projectId,
              keyword: metric.keyword.toLowerCase(),
              ...market,
              searchVolume: metric.searchVolume,
              cpc: metric.cpc,
              competition: metric.competition,
              keywordDifficulty: metric.keywordDifficulty,
              intent: normalizeIntent(metric.intent),
              monthlySearchesJson: JSON.stringify(metric.monthlySearches),
            }),
          ),
        );
      }
    }
  }

  const fetchedRows = new Map(
    fetched.map((metric) => [metric.keyword.toLowerCase(), metric]),
  );
  return keywords.flatMap((keyword) => {
    const row = storedRows.get(keyword) ?? fetchedRows.get(keyword);
    return row ? [row] : [];
  });
}
