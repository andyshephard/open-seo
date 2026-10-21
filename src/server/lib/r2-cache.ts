import { env } from "cloudflare:workers";
import { sortBy } from "remeda";

/**
 * Cache TTL constants in seconds.
 */
export const CACHE_TTL = {
  /** Related keyword research results */
  researchResult: 30 * 86400,
} as const;

/**
 * How long a paid research result is reused before OpenSEO buys it again
 * ("balanced" defaults). Provider data moves slowly: Labs domain metrics and
 * keyword volumes update about monthly, backlink indexes daily, SERPs hourly.
 * Users and agents can always force a live fetch with `refresh`.
 */
export const RESEARCH_FRESHNESS_SECONDS = {
  domain: 7 * 86400,
  backlinks: 3 * 86400,
  keywords: 30 * 86400,
  serp: 86400,
  aiSearch: 7 * 86400,
  local: 7 * 86400,
  /** Empty results: short, since providers report "no data" transiently. */
  empty: 6 * 3600,
} as const;

const CACHE_PREFIX = "dataforseo-cache/";

export const AI_SEARCH_PROMPT_CACHE_NAMESPACE = "ai-search:prompt-response";

/** Full R2 object-key prefix for a cache namespace, for prefix listing. */
export function cacheObjectPrefix(namespace: string): string {
  return `${CACHE_PREFIX}${namespace}:`;
}

/**
 * Build a deterministic cache key from an endpoint slug and input params.
 * Uses a SHA-256 digest for stability across runtimes.
 */
export async function buildCacheKey(
  prefix: string,
  params: Record<string, unknown>,
): Promise<string> {
  const raw = JSON.stringify(
    Object.fromEntries(sortBy(Object.entries(params), ([key]) => key)),
  );

  return `${prefix}:${await sha256Hex(raw)}`;
}

/**
 * How fresh a cached provider result must be. `refresh` skips the cache (the
 * caller pays for a live fetch); `maxAgeDays` tightens the entry's own TTL,
 * e.g. an agent that needs data from the last day.
 */
export type CacheFreshness = { refresh?: boolean; maxAgeDays?: number };

/**
 * Get a cached JSON value from R2 with the time it was stored. Returns null on
 * miss, expiry, or when `freshness` rejects it. Callers should validate the
 * shape with Zod before trusting it — schema drift between writes and reads is
 * otherwise silent.
 */
export async function getCachedEntry(
  key: string,
  freshness: CacheFreshness = {},
): Promise<{ value: unknown; storedAt: string } | null> {
  if (freshness.refresh) return null;
  const obj = await env.R2.get(`${CACHE_PREFIX}${key}`);
  if (!obj) return null;

  const expiresAt = obj.customMetadata?.expiresAt;
  if (expiresAt && Date.parse(expiresAt) < Date.now()) return null;
  if (
    freshness.maxAgeDays != null &&
    Date.now() - obj.uploaded.getTime() > freshness.maxAgeDays * 86_400_000
  )
    return null;

  try {
    return {
      value: JSON.parse(await obj.text()) as unknown,
      storedAt: obj.uploaded.toISOString(),
    };
  } catch {
    return null;
  }
}

/** The cached value only; see getCachedEntry. */
export async function getCached(
  key: string,
  freshness?: CacheFreshness,
): Promise<unknown> {
  return (await getCachedEntry(key, freshness))?.value ?? null;
}

/**
 * Store a JSON value in R2 with a soft TTL via custom metadata.
 */
export async function setCached<T>(
  key: string,
  data: T,
  ttlSeconds: number,
  metadata: Record<string, string> = {},
): Promise<void> {
  await env.R2.put(`${CACHE_PREFIX}${key}`, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      ...metadata,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    },
  });
}

/**
 * Compute a deterministic SHA-256 digest for cache keys.
 */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
