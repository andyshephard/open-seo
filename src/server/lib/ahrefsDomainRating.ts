import { env } from "cloudflare:workers";
import { z } from "zod";

/**
 * Ahrefs publishes a free, keyless Domain Rating lookup. Every result (a DR,
 * or `null` when Ahrefs has no rating) is cached in KV for a day, so repeat
 * lookups are free; backlinks snapshots also record it as a dated trend.
 */
const AHREFS_DR_ENDPOINT =
  "https://api.ahrefs.com/v3/public/domain-rating-free";
const CACHE_PREFIX = "ahrefs-dr:";
const CACHE_TTL_SECONDS = 86_400; // 24 hours
const FETCH_TIMEOUT_MS = 5_000;

const ahrefsResponseSchema = z.object({
  domain_rating: z.object({
    domain_rating: z.number().min(0).max(100),
  }),
});

/** Cache-first lookup for a single normalized domain. */
export async function resolveDomainRating(
  domain: string,
): Promise<number | null> {
  const cacheKey = `${CACHE_PREFIX}${domain}`;
  // KV returns JS `null` only when the key is absent; a cached "no rating" is
  // stored as the string "null", so cache hits (including nulls) skip the fetch.
  const cached = await env.KV.get(cacheKey);
  if (cached !== null) return parseCachedRating(cached);

  const dr = await fetchDomainRating(domain);
  await env.KV.put(cacheKey, JSON.stringify(dr), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
  return dr;
}

async function fetchDomainRating(domain: string): Promise<number | null> {
  const response = await fetch(
    `${AHREFS_DR_ENDPOINT}?target=${encodeURIComponent(domain)}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!response.ok) {
    throw new Error(`Ahrefs DR lookup failed with status ${response.status}`);
  }

  const parsed = ahrefsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Ahrefs DR lookup returned an unexpected response");
  }

  // Ahrefs returns 200 with DR 0 for domains it has no rating for (new or
  // unknown), so treat 0 as "no rating" — the table renders it as "—".
  const dr = parsed.data.domain_rating.domain_rating;
  return dr > 0 ? dr : null;
}

function parseCachedRating(raw: string): number | null {
  try {
    const value: unknown = JSON.parse(raw);
    // Mirror fetchDomainRating: a DR of 0 means "no rating", so render it as "—".
    return typeof value === "number" && value > 0 ? value : null;
  } catch {
    return null;
  }
}
