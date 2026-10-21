import type { SerpLiveItem } from "@/server/lib/dataforseo";
import type { CacheFreshness } from "@/server/lib/r2-cache";
import { getSerpSnapshot } from "./serpSnapshot";
import type { SerpResultItem } from "@/types/keywords";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { assertLocalResearchLocation } from "./local-volume";

type SerpAnalysisReason = "no_organic_results";

type SerpAnalysisResult = {
  requestedKeyword: string;
  items: SerpResultItem[];
  /** SERP depth this snapshot was crawled at — how deep the results go. */
  depth: number;
  reason?: SerpAnalysisReason;
};

function mapOrganicSerpItems(items: SerpLiveItem[]): SerpResultItem[] {
  return items
    .filter((item) => item.type === "organic")
    .map((item) => ({
      rank: item.rank_group ?? item.rank_absolute ?? 0,
      title: item.title ?? "",
      url: item.url ?? "",
      domain: item.domain ?? "",
      description: item.description ?? "",
      etv: item.etv ?? null,
      estimatedPaidTrafficCost: item.estimated_paid_traffic_cost ?? null,
      referringDomains: item.backlinks_info?.referring_domains ?? null,
      backlinks: item.backlinks_info?.backlinks ?? null,
      isNew: false,
      rankChange: null,
    }));
}

async function getSerpLiveAnalysis(
  input: {
    projectId: string;
    keyword: string;
    locationCode: number;
    languageCode: string;
    depth: number;
    locationName?: string;
    asOf?: string;
  } & CacheFreshness,
  billingCustomer: BillingCustomerContext,
): Promise<SerpAnalysisResult> {
  if (input.locationName && !input.asOf) {
    await assertLocalResearchLocation(input.locationCode, input.locationName);
  }
  const snapshot = await getSerpSnapshot(input, billingCustomer);
  const items = mapOrganicSerpItems(snapshot.items);
  return {
    requestedKeyword: snapshot.keyword,
    items,
    depth: snapshot.depth,
    ...(items.length === 0 ? { reason: "no_organic_results" as const } : {}),
  };
}

export const getSerpAnalysis = getSerpLiveAnalysis;
