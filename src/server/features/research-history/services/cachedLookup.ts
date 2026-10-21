import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  buildCacheKey,
  getCachedEntry,
  RESEARCH_FRESHNESS_SECONDS,
  setCached,
  type CacheFreshness,
} from "@/server/lib/r2-cache";
import {
  RESEARCH_ARCHIVE_KINDS,
  type ResearchArchiveKind,
} from "@/types/schemas/researchHistory";
import { archiveLookup, readArchivedView } from "./researchArchive";

// Cache-first storage for paid provider lookups that have no feature service
// of their own (local SEO, SERP competitors, MCP-only reads). A stored result
// inside the freshness window is returned free; a fresh one is cached for the
// org and archived for the project, like every other research lookup.

type Market = { locationCode: number; languageCode: string };

export type LookupRequest = {
  kind: ResearchArchiveKind;
  target: string;
  /** Every request field that changes the provider result. */
  params: Record<string, unknown>;
  market?: Market;
};

type LookupOptions<T> = LookupRequest & {
  ttlSeconds: number;
  schema: z.ZodType<T>;
  isEmpty?: (value: T) => boolean;
  asOf?: string;
} & CacheFreshness;

function lookupKey(customer: BillingCustomerContext, request: LookupRequest) {
  return buildCacheKey(`lookup:${request.kind}`, {
    organizationId: customer.organizationId,
    target: request.target,
    ...request.params,
    ...request.market,
  });
}

/** The stored result for this request, if it is fresh enough (or archived as of `asOf`). */
export async function readCachedLookup<T>(
  customer: BillingCustomerContext,
  lookup: LookupOptions<T>,
): Promise<{ value: T; fetchedAt: string } | null> {
  const viewKey = await lookupKey(customer, lookup);
  if (lookup.asOf)
    return {
      value: lookup.schema.parse(
        await readArchivedView(customer, viewKey, lookup.asOf),
      ),
      fetchedAt: lookup.asOf,
    };
  const entry = await getCachedEntry(viewKey, lookup);
  const cached = entry ? lookup.schema.safeParse(entry.value) : null;
  if (!entry || !cached?.success) return null;
  // A project reading an org-shared result for the first time archives it.
  if (!lookup.isEmpty?.(cached.data))
    await archiveLookup(customer, {
      ...lookup,
      viewKey,
      fetchedAt: entry.storedAt,
      payload: cached.data,
    });
  return { value: cached.data, fetchedAt: entry.storedAt };
}

/** Caches and archives a freshly bought result. */
export async function storeLookupResult<T>(
  customer: BillingCustomerContext,
  lookup: LookupOptions<T>,
  value: T,
) {
  const viewKey = await lookupKey(customer, lookup);
  const empty = lookup.isEmpty?.(value) ?? false;
  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(
      viewKey,
      value,
      empty ? RESEARCH_FRESHNESS_SECONDS.empty : lookup.ttlSeconds,
    ).catch((error) => {
      console.error(`lookup.${lookup.kind}.cache-write failed:`, error);
    }),
  );
  if (!empty)
    await archiveLookup(customer, {
      ...lookup,
      viewKey,
      fetchedAt: new Date().toISOString(),
      payload: value,
    });
}

/** readCachedLookup, else `fetch` and storeLookupResult. */
export async function cachedLookup<T>(
  customer: BillingCustomerContext,
  lookup: LookupOptions<T>,
  fetch: () => Promise<T>,
): Promise<{ value: T; fetchedAt: string; cached: boolean }> {
  const stored = await readCachedLookup(customer, lookup);
  if (stored) return { ...stored, cached: true };
  const value = await fetch();
  await storeLookupResult(customer, lookup, value);
  return { value, fetchedAt: new Date().toISOString(), cached: false };
}

// Queued provider tasks (reviews, posts) finish after the call that posted
// them. The posting call remembers which request a task belongs to, so the
// call that collects it can store the result under that request.
const lookupRequestSchema = z.object({
  kind: z.enum(RESEARCH_ARCHIVE_KINDS),
  target: z.string(),
  params: z.record(z.string(), z.unknown()),
  market: z
    .object({ locationCode: z.number(), languageCode: z.string() })
    .optional(),
});

const TASK_MEMORY_SECONDS = 7 * 86400;

function taskKey(customer: BillingCustomerContext, taskId: string) {
  return buildCacheKey("lookup-task", {
    organizationId: customer.organizationId,
    taskId,
  });
}

export async function rememberLookupTask(
  customer: BillingCustomerContext,
  taskId: string,
  request: LookupRequest,
) {
  await setCached(
    await taskKey(customer, taskId),
    request,
    TASK_MEMORY_SECONDS,
  ).catch((error) => {
    console.error("lookup-task.remember failed:", error);
  });
}

export async function recallLookupTask(
  customer: BillingCustomerContext,
  taskId: string,
): Promise<LookupRequest | null> {
  const entry = await getCachedEntry(await taskKey(customer, taskId));
  const parsed = lookupRequestSchema.safeParse(entry?.value);
  return parsed.success ? parsed.data : null;
}
