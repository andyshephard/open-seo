import { env } from "cloudflare:workers";
import { CACHE_PREFIX } from "@/server/lib/r2-cache";

// Deletes cached provider responses past their TTL. Reads already ignore them,
// but nothing removed them where R2 has no lifecycle rules (the standalone
// Docker edition), so the cache grew forever. Runs from the daily cron in
// every mode; on Cloudflare the bucket's lifecycle rule is only a backstop.
//
// Only `dataforseo-cache/` is listed, never `research-archive/` or anything
// else in the bucket. Each run is bounded (SWEEP_PAGES_PER_RUN listings of up
// to 1000 keys, one delete per listing) and saves its place in KV, so a large
// cache is covered over several days instead of one long invocation.

const SWEEP_CURSOR_KEY = "r2-cache-sweep:cursor";
const SWEEP_PAGES_PER_RUN = 20;
const SWEEP_PAGE_SIZE = 1000;
// Every write stamps expiresAt (setCached). An object without a readable one
// is judged by age against the longest TTL any writer uses (the dashboard's
// 90-day last-good copy, DashboardCacheService.ts).
const UNDATED_MAX_AGE_MS = 90 * 86_400_000;

function isExpired(object: R2Object, now: number) {
  const expiresAt = Date.parse(object.customMetadata?.expiresAt ?? "");
  if (!Number.isNaN(expiresAt)) return expiresAt < now;
  return object.uploaded.getTime() + UNDATED_MAX_AGE_MS < now;
}

export async function sweepExpiredCache(now = Date.now()) {
  let cursor = (await env.KV.get(SWEEP_CURSOR_KEY)) ?? undefined;
  let scanned = 0;
  let deleted = 0;
  try {
    for (let page = 0; page < SWEEP_PAGES_PER_RUN; page += 1) {
      const listing = await env.R2.list({
        prefix: CACHE_PREFIX,
        cursor,
        limit: SWEEP_PAGE_SIZE,
        include: ["customMetadata"],
      });
      const expired = listing.objects
        .filter(
          (object) =>
            object.key.startsWith(CACHE_PREFIX) && isExpired(object, now),
        )
        .map((object) => object.key);
      if (expired.length > 0) await env.R2.delete(expired);
      scanned += listing.objects.length;
      deleted += expired.length;
      cursor = listing.truncated ? listing.cursor : undefined;
      if (!cursor) break;
    }
  } catch (error) {
    // A stale saved cursor would fail every run; start over next time.
    await env.KV.delete(SWEEP_CURSOR_KEY);
    throw error;
  }
  if (cursor) await env.KV.put(SWEEP_CURSOR_KEY, cursor);
  else await env.KV.delete(SWEEP_CURSOR_KEY);
  return { scanned, deleted, complete: !cursor };
}
