import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  archiveLookup,
  readArchivedView,
} from "@/server/features/research-history/services/researchArchive";
import {
  serpSnapshotItemSchema,
  type SerpLiveItem,
} from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import {
  buildCacheKey,
  getCachedEntry,
  RESEARCH_FRESHNESS_SECONDS,
  setCached,
  type CacheFreshness,
} from "@/server/lib/r2-cache";
import { normalizeKeyword } from "./helpers";
import { readMergedSerps, type MergedSerpItem } from "./serpReads";

// One Google SERP per keyword and market, shared by the Keyword Research SERP
// panel, the get_serp_results MCP tool and Prompt Research. Every result type
// is kept, so each caller takes the view it needs from the same paid crawl.
// Misses are bought as upstream's merged reads (serpReads.ts); this layer adds
// the shared freshness window and the research archive on top of its receipts.

const serpSnapshotSchema = z.object({
  keyword: z.string(),
  depth: z.number().int(),
  fetchedAt: z.string(),
  // seenIn: how many of the merged reads showed the row; absent in snapshots
  // stored before reads were merged.
  items: z.array(
    serpSnapshotItemSchema.extend({ seenIn: z.number().optional() }),
  ),
});

type SerpSnapshot = {
  keyword: string;
  depth: number;
  fetchedAt: string;
  items: Array<SerpLiveItem & { seenIn?: number }>;
};

type SerpSnapshotInput = {
  keyword: string;
  locationCode: number;
  languageCode: string;
  locationName?: string;
  depth: number;
  /** Desktop when omitted. */
  device?: "desktop" | "mobile";
  asOf?: string;
} & CacheFreshness;

type SerpSnapshotLookup = {
  keyword: string;
  cacheKey: string;
  /** The stored snapshot that answers the request, if any. */
  snapshot: SerpSnapshot | null;
  /** A stored snapshot too shallow to answer, kept so an empty re-read can't evict it. */
  shallower: SerpSnapshot | null;
};

/**
 * Answers from the archive (`asOf`) or the shared cache, or says it can't.
 * A hit is archived so a view served from the cache still lands in history.
 */
export async function lookupSerpSnapshot(
  input: SerpSnapshotInput,
  billingCustomer: BillingCustomerContext,
): Promise<SerpSnapshotLookup> {
  const keyword = normalizeKeyword(input.keyword);
  // Depth lives in the value, not the key: DataForSEO has no offset, so a
  // deeper crawl re-fetches the head too and also answers shallower requests.
  const cacheKey = await buildCacheKey("serp:snapshot", {
    organizationId: billingCustomer.organizationId,
    keyword,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    locationName: input.locationName,
    // Omitted for desktop so desktop keys match snapshots stored before the
    // device option existed.
    device: input.device === "mobile" ? "mobile" : undefined,
  });
  if (input.asOf)
    return {
      keyword,
      cacheKey,
      snapshot: serpSnapshotSchema.parse(
        await readArchivedView(billingCustomer, cacheKey, input.asOf),
      ),
      shallower: null,
    };

  const cached = serpSnapshotSchema.safeParse(
    (await getCachedEntry(cacheKey, input))?.value,
  );
  if (cached.success && cached.data.depth >= input.depth) {
    if (cached.data.items.length > 0)
      await archiveSerpSnapshot(
        input,
        keyword,
        cacheKey,
        cached.data,
        billingCustomer,
      );
    return { keyword, cacheKey, snapshot: cached.data, shallower: null };
  }
  return {
    keyword,
    cacheKey,
    snapshot: null,
    shallower: cached.success ? cached.data : null,
  };
}

function archiveSerpSnapshot(
  input: SerpSnapshotInput,
  keyword: string,
  cacheKey: string,
  snapshot: SerpSnapshot,
  billingCustomer: BillingCustomerContext,
) {
  return archiveLookup(billingCustomer, {
    kind: "serp_analysis",
    target: keyword,
    viewKey: cacheKey,
    params: {
      depth: snapshot.depth,
      ...(input.locationName ? { locationName: input.locationName } : {}),
      ...(input.device === "mobile" ? { device: "mobile" } : {}),
    },
    market: input,
    fetchedAt: snapshot.fetchedAt,
    payload: snapshot,
  });
}

/** Caches and archives a snapshot bought through `readMergedSerps`. */
export async function storeSerpSnapshot(
  input: SerpSnapshotInput,
  lookup: SerpSnapshotLookup,
  items: MergedSerpItem[],
  billingCustomer: BillingCustomerContext,
): Promise<SerpSnapshot> {
  const snapshot: SerpSnapshot = {
    keyword: lookup.keyword,
    depth: input.depth,
    fetchedAt: new Date().toISOString(),
    items,
  };
  // DataForSEO reports "no results" transiently, and a deeper crawl overwrites
  // the same key. Without this guard one empty re-crawl would evict a good
  // snapshot and, being the deeper entry, answer every shallower request with
  // nothing for the rest of the TTL.
  if (items.length === 0 && (lookup.shallower?.items.length ?? 0) > 0)
    return snapshot;

  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(
      lookup.cacheKey,
      snapshot,
      items.length > 0
        ? RESEARCH_FRESHNESS_SECONDS.serp
        : RESEARCH_FRESHNESS_SECONDS.empty,
    ).catch((error) => {
      console.error("keywords.serp-snapshot.cache-write failed:", error);
    }),
  );
  if (items.length > 0)
    await archiveSerpSnapshot(
      input,
      lookup.keyword,
      lookup.cacheKey,
      snapshot,
      billingCustomer,
    );
  return snapshot;
}

/**
 * The read receipt keeps a repeat of the same query free for 12 hours, which
 * would answer a `refresh` with the old reads. A refresh gets a receipt per
 * 10 minutes instead, so a retry of a still-running refresh collects it.
 */
export function serpReceiptRefreshSuffix(input: CacheFreshness) {
  return input.refresh
    ? { refreshWindow: Math.floor(Date.now() / 600_000) }
    : {};
}

/** Reads one keyword's merged SERP, from the cache when it is fresh enough. */
export async function getSerpSnapshot(
  input: SerpSnapshotInput,
  billingCustomer: BillingCustomerContext,
): Promise<SerpSnapshot> {
  const lookup = await lookupSerpSnapshot(input, billingCustomer);
  if (lookup.snapshot) return lookup.snapshot;

  const [outcome] = await readMergedSerps(billingCustomer, [
    {
      query: {
        keyword: lookup.keyword,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        locationName: input.locationName,
        depth: input.depth,
        device: input.device,
      },
      receiptKey: await buildCacheKey("serp:snapshot-reads", {
        organizationId: billingCustomer.organizationId,
        keyword: lookup.keyword,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        locationName: input.locationName,
        depth: input.depth,
        device: input.device === "mobile" ? "mobile" : undefined,
        ...serpReceiptRefreshSuffix(input),
      }),
    },
  ]);
  if (outcome.status === "failed") throw outcome.error;
  if (outcome.status === "processing") {
    // Retrying collects the same reads at no charge.
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "These search results are taking longer than usual.",
    );
  }
  return storeSerpSnapshot(input, lookup, outcome.items, billingCustomer);
}
