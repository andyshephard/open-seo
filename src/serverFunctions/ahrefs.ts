import { createServerFn } from "@tanstack/react-start";
import { chunk } from "remeda";
import { z } from "zod";
import { normalizeDomainInput } from "@/server/lib/domainUtils";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { resolveDomainRating } from "@/server/lib/ahrefsDomainRating";

/**
 * Enriches the Backlinks table with Ahrefs' free Domain Rating, on demand;
 * see ahrefsDomainRating for caching.
 */
const FETCH_BATCH_SIZE = 20;
const MAX_DOMAINS_PER_CALL = 100;

const domainRatingsInputSchema = z.object({
  projectId: z.string().min(1),
  domains: z.array(z.string().trim().min(1).max(253)).max(MAX_DOMAINS_PER_CALL),
});

export const getAhrefsDomainRatings = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(domainRatingsInputSchema)
  .handler(async ({ data }) => {
    const result: Record<string, number | null> = {};

    // Several original inputs can collapse to one normalized domain (www/non-www,
    // protocol variants). Resolve each normalized domain once, then fan the value
    // back out to every original key the client will look up by.
    const originalsByDomain = new Map<string, string[]>();
    for (const original of data.domains) {
      const domain = normalizeDomainInput(original, true);
      const existing = originalsByDomain.get(domain);
      if (existing) existing.push(original);
      else originalsByDomain.set(domain, [original]);
    }

    const ratings = new Map<string, number | null>();
    for (const batch of chunk(
      [...originalsByDomain.keys()],
      FETCH_BATCH_SIZE,
    )) {
      const resolved = await Promise.all(
        batch.map(async (domain) => {
          // A single failure (KV blip, etc.) must not fail the whole call.
          try {
            return [domain, await resolveDomainRating(domain)] as const;
          } catch {
            return [domain, null] as const;
          }
        }),
      );
      for (const [domain, dr] of resolved) ratings.set(domain, dr);
    }

    for (const [domain, originals] of originalsByDomain) {
      const dr = ratings.get(domain) ?? null;
      for (const original of originals) result[original] = dr;
    }

    return result;
  });
