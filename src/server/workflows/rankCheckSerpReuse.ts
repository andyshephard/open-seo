import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { archiveLookup } from "@/server/features/research-history/services/researchArchive";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type {
  createDataforseoClient,
  RankCheckResult,
  RankCheckTaskInput,
} from "@/server/lib/dataforseo";
import type { RankCheckSerpItem } from "@/server/lib/dataforseo/serp";
import {
  buildCacheKey,
  getCachedEntry,
  RESEARCH_FRESHNESS_SECONDS,
  setCached,
} from "@/server/lib/r2-cache";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import { z } from "zod";

// Rank-check results pages: snapshot rows, the per-tracker archive, and the
// org-wide same-day share that lets one tracker's paid page answer another's.

export type KeywordEntry = { id: string; keyword: string };
export type RankCheckResultWithDevice = RankCheckResult & {
  device: "desktop" | "mobile";
};

export function mapResultsToSnapshotRows(
  runId: string,
  results: RankCheckResultWithDevice[],
) {
  return results.map((r) => ({
    runId,
    trackingKeywordId: r.keywordId,
    keyword: r.keyword,
    device: r.device,
    position: r.position,
    url: r.url,
    serpFeatures:
      r.serpFeatures.length > 0 ? JSON.stringify(r.serpFeatures) : null,
  }));
}

export interface CheckContext {
  client: ReturnType<typeof createDataforseoClient>;
  billingCustomer: BillingCustomerContext;
  configId: string;
  keywords: KeywordEntry[];
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
  domain: string;
  locationCode: number;
  languageCode: string;
  locationName?: string;
  runId: string;
}

// Archive writes per round run in small parallel groups: one R2 put and one
// row each, for every keyword/device result.
const ARCHIVE_CONCURRENCY = 10;

const sharedSerpSchema = z.object({
  depth: z.number(),
  items: z.array(
    z.object({
      type: z.string().nullable(),
      rankGroup: z.number().nullable(),
      rankAbsolute: z.number().nullable(),
      domain: z.string().nullable(),
      url: z.string().nullable(),
      title: z.string().nullable(),
    }),
  ),
});

// A results page is the same for every tracker on the same keyword, market and
// device, so a page one tracker bought today answers another tracker's check
// (e.g. a competitor's tracker on the same keywords) for free.
function sharedSerpKey(
  ctx: CheckContext,
  task: { keyword: string; device: "desktop" | "mobile" },
) {
  return buildCacheKey("rank-serp", {
    organizationId: ctx.billingCustomer.organizationId,
    keyword: task.keyword.toLowerCase(),
    locationCode: ctx.locationCode,
    languageCode: ctx.languageCode,
    locationName: ctx.locationName,
    device: task.device,
  });
}

function rankFromSerp(
  task: RankCheckTaskInput,
  domain: string,
  items: RankCheckSerpItem[],
): RankCheckResultWithDevice {
  const target = domain.toLowerCase();
  const match = items.find((item) => {
    if (item.type !== "organic" || item.domain == null) return false;
    const itemDomain = item.domain.toLowerCase();
    return itemDomain === target || itemDomain.endsWith(`.${target}`);
  });
  return {
    keywordId: task.keywordId,
    keyword: task.keyword,
    device: task.device,
    // Organic position, as in buildRankCheckResult.
    position: match ? (match.rankGroup ?? match.rankAbsolute ?? null) : null,
    url: match?.url ?? null,
    serpFeatures: [
      ...new Set(items.flatMap((item) => (item.type ? [item.type] : []))),
    ],
    serpItems: items,
  };
}

/**
 * Answers the tasks whose results page another check bought today, writes
 * their snapshots, and returns the tasks that still need a paid check.
 */
export async function reuseSharedSerps(
  ctx: CheckContext,
  tasks: RankCheckTaskInput[],
): Promise<RankCheckTaskInput[]> {
  const reused: RankCheckResultWithDevice[] = [];
  const remaining: RankCheckTaskInput[] = [];
  for (let i = 0; i < tasks.length; i += ARCHIVE_CONCURRENCY) {
    const chunk = tasks.slice(i, i + ARCHIVE_CONCURRENCY);
    const entries = await Promise.all(
      chunk.map(async (task) =>
        sharedSerpSchema.safeParse(
          (await getCachedEntry(await sharedSerpKey(ctx, task)))?.value,
        ),
      ),
    );
    chunk.forEach((task, index) => {
      const entry = entries[index];
      if (entry.success && entry.data.depth >= ctx.serpDepth)
        reused.push(rankFromSerp(task, ctx.domain, entry.data.items));
      else remaining.push(task);
    });
  }
  if (reused.length > 0) {
    await RankTrackingRepository.insertSnapshots(
      mapResultsToSnapshotRows(ctx.runId, reused),
    );
    await archiveSerps(ctx, reused, false);
  }
  return remaining;
}

/**
 * Archives each checked results page; failures are logged by archiveLookup.
 * Freshly bought pages are also shared with other trackers for the day.
 */
export async function archiveSerps(
  ctx: CheckContext,
  results: RankCheckResultWithDevice[],
  share = true,
) {
  const fetchedAt = new Date().toISOString();
  for (let i = 0; i < results.length; i += ARCHIVE_CONCURRENCY) {
    await Promise.all(
      results.slice(i, i + ARCHIVE_CONCURRENCY).flatMap((result) => [
        share
          ? sharedSerpKey(ctx, result).then((key) =>
              setCached(
                key,
                { depth: ctx.serpDepth, items: result.serpItems },
                RESEARCH_FRESHNESS_SECONDS.serp,
              ).catch((error) => {
                console.error("[rank-check] shared SERP write failed:", error);
              }),
            )
          : Promise.resolve(),
        archiveLookup(ctx.billingCustomer, {
          kind: "rank_check_serp",
          target: result.keyword,
          // One series per tracked keyword and device.
          viewKey: `rank-serp:${ctx.configId}:${result.keywordId}:${result.device}`,
          params: {
            configId: ctx.configId,
            runId: ctx.runId,
            trackingKeywordId: result.keywordId,
            device: result.device,
            domain: ctx.domain,
          },
          market: {
            locationCode: ctx.locationCode,
            languageCode: ctx.languageCode,
          },
          fetchedAt,
          payload: {
            keyword: result.keyword,
            device: result.device,
            position: result.position,
            url: result.url,
            items: result.serpItems,
          },
        }),
      ]),
    );
  }
}
