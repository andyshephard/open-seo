import { z } from "zod";
import {
  getArchiveEntry,
  listArchive,
} from "@/server/features/research-history/services/researchArchive";
import { normalizeKeyword } from "./helpers";
import type { SerpResultRow } from "./serpClustering";

// Reads SERPs OpenSEO already bought from the research archive (every SERP the
// app, an agent or Prompt Research fetched is archived for 13 months), so a
// caller can use them without buying them again.

const storedSerpSchema = z.object({
  fetchedAt: z.string(),
  items: z.array(
    z.object({
      type: z.string(),
      rank_group: z.number().nullable().optional(),
      rank_absolute: z.number().nullable().optional(),
      domain: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
    }),
  ),
});

type StoredSerp = { fetchedAt: string; results: SerpResultRow[] };

type SerpItems = z.infer<typeof storedSerpSchema>["items"];

/** The organic rows of a stored or fresh SERP, shaped for clustering. */
export function organicSerpRows(items: SerpItems): SerpResultRow[] {
  return items
    .filter((item) => item.type === "organic")
    .map((item) => ({
      url: item.url ?? null,
      title: item.title ?? null,
      domain: item.domain ?? null,
      position: item.rank_group ?? item.rank_absolute ?? null,
    }));
}

function isNationalDesktop(params: string) {
  try {
    const parsed = z
      .object({
        device: z.string().optional(),
        locationName: z.string().optional(),
      })
      .parse(JSON.parse(params));
    return parsed.device !== "mobile" && !parsed.locationName;
  } catch {
    return true;
  }
}

/**
 * The newest archived national desktop SERP for the keyword and market that is
 * at most `maxAgeDays` old, or null. Uses no credits.
 */
export async function readStoredSerp(input: {
  projectId: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  maxAgeDays: number;
}): Promise<StoredSerp | null> {
  const from = new Date(
    Date.now() - input.maxAgeDays * 86_400_000,
  ).toISOString();
  const { entries } = await listArchive({
    projectId: input.projectId,
    kinds: ["serp_analysis"],
    target: normalizeKeyword(input.keyword),
    from,
    limit: 10,
  });
  const match = entries.find(
    (entry) =>
      entry.locationCode === input.locationCode &&
      entry.languageCode === input.languageCode &&
      isNationalDesktop(entry.params),
  );
  if (!match) return null;
  const { result } = await getArchiveEntry(input.projectId, match.id);
  const parsed = storedSerpSchema.safeParse(result);
  if (!parsed.success) return null;
  return {
    fetchedAt: parsed.data.fetchedAt,
    results: organicSerpRows(parsed.data.items),
  };
}
