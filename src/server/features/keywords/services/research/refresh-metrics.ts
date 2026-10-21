import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { getKeywordMetrics } from "@/server/features/keywords/services/keywordMetricsStore";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CacheFreshness } from "@/server/lib/r2-cache";
import type { RefreshSavedKeywordMetricsInput } from "@/types/schemas/keywords";

/**
 * Brings saved keyword metrics up to date. Keywords whose stored metrics are
 * still inside the freshness window keep them for free (volumes update about
 * monthly); `refresh` buys every keyword again.
 */
export async function refreshSavedKeywordMetrics(
  input: RefreshSavedKeywordMetricsInput & CacheFreshness,
  billingCustomer: BillingCustomerContext,
): Promise<{ updated: number }> {
  const { rows } = await KeywordResearchRepository.listSavedKeywordsByProject({
    projectId: input.projectId,
  });

  if (rows.length === 0) return { updated: 0 };

  // Group by (locationCode, languageCode) so each provider call is homogeneous.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.row.locationCode}:${row.row.languageCode}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  let updated = 0;
  for (const groupRows of groups.values()) {
    const { locationCode, languageCode } = groupRows[0].row;
    const metrics = await getKeywordMetrics(
      {
        projectId: input.projectId,
        keywords: groupRows.map((r) => r.row.keyword),
        locationCode,
        languageCode,
        creditFeature: "keyword_research",
        refresh: input.refresh,
        maxAgeDays: input.maxAgeDays,
      },
      billingCustomer,
    );
    updated += metrics.length;
  }

  return { updated };
}
