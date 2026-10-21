import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  archiveLookup,
  readArchivedView,
} from "@/server/features/research-history/services/researchArchive";
import {
  createDataforseoClient,
  serpSnapshotItemSchema,
  type SerpLiveItem,
} from "@/server/lib/dataforseo";
import {
  buildCacheKey,
  getCachedEntry,
  RESEARCH_FRESHNESS_SECONDS,
  setCached,
  type CacheFreshness,
} from "@/server/lib/r2-cache";
import { normalizeKeyword } from "./helpers";

// One Google SERP per keyword and market, shared by the Keyword Research SERP
// panel, the get_serp_results MCP tool and Prompt Research. Every result type
// is kept, so each caller takes the view it needs from the same paid crawl.

const serpSnapshotSchema = z.object({
  keyword: z.string(),
  depth: z.number().int(),
  fetchedAt: z.string(),
  items: z.array(serpSnapshotItemSchema),
});

type SerpSnapshot = {
  keyword: string;
  depth: number;
  fetchedAt: string;
  items: SerpLiveItem[];
};

export async function getSerpSnapshot(
  input: {
    keyword: string;
    locationCode: number;
    languageCode: string;
    locationName?: string;
    depth: number;
    asOf?: string;
  } & CacheFreshness,
  billingCustomer: BillingCustomerContext,
): Promise<SerpSnapshot> {
  const keyword = normalizeKeyword(input.keyword);
  // Depth lives in the value, not the key: DataForSEO has no offset, so a
  // deeper crawl re-fetches the head too and also answers shallower requests.
  const cacheKey = await buildCacheKey("serp:snapshot", {
    organizationId: billingCustomer.organizationId,
    keyword,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    locationName: input.locationName,
  });
  const archive = (snapshot: SerpSnapshot) =>
    archiveLookup(billingCustomer, {
      kind: "serp_analysis",
      target: keyword,
      viewKey: cacheKey,
      params: {
        depth: snapshot.depth,
        ...(input.locationName ? { locationName: input.locationName } : {}),
      },
      market: input,
      fetchedAt: snapshot.fetchedAt,
      payload: snapshot,
    });

  if (input.asOf)
    return serpSnapshotSchema.parse(
      await readArchivedView(billingCustomer, cacheKey, input.asOf),
    );

  const cached = serpSnapshotSchema.safeParse(
    (await getCachedEntry(cacheKey, input))?.value,
  );
  if (cached.success && cached.data.depth >= input.depth) {
    if (cached.data.items.length > 0) await archive(cached.data);
    return cached.data;
  }

  const items = await createDataforseoClient(billingCustomer).serp.live({
    keyword,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    locationName: input.locationName,
    depth: input.depth,
  });
  const snapshot: SerpSnapshot = {
    keyword,
    depth: input.depth,
    fetchedAt: new Date().toISOString(),
    items,
  };
  // DataForSEO reports "no results" transiently, and a deeper crawl overwrites
  // the same key. Without this guard one empty re-crawl would evict a good
  // snapshot and, being the deeper entry, answer every shallower request with
  // nothing for the rest of the TTL.
  if (items.length === 0 && cached.success && cached.data.items.length > 0)
    return snapshot;

  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(
      cacheKey,
      snapshot,
      items.length > 0
        ? RESEARCH_FRESHNESS_SECONDS.serp
        : RESEARCH_FRESHNESS_SECONDS.empty,
    ).catch((error) => {
      console.error("keywords.serp-snapshot.cache-write failed:", error);
    }),
  );
  if (items.length > 0) await archive(snapshot);
  return snapshot;
}
