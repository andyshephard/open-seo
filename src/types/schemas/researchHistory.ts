import { z } from "zod";

export const RESEARCH_SNAPSHOT_INTERVALS = ["weekly", "monthly"] as const;
export type ResearchSnapshotInterval =
  (typeof RESEARCH_SNAPSHOT_INTERVALS)[number];

export const RESEARCH_HISTORY_MONTHS = [3, 6, 12] as const;

export const RESEARCH_ARCHIVE_KINDS = [
  "domain_overview",
  "domain_keywords",
  "domain_pages",
  "domain_keyword_suggestions",
  "ranked_keywords",
  "backlinks_overview",
  "backlinks_rows",
  "backlinks_referring_domains",
  "backlinks_top_pages",
  "keyword_research",
  "keyword_metrics",
  "serp_analysis",
  "rank_check_serp",
  "serp_competitors",
  "local_businesses",
  "local_serp",
  "local_rank_grid",
  "business_questions",
  "business_profile",
  "business_reviews",
  "business_updates",
  "brand_lookup",
  "prompt_research",
  "prompt_explorer",
] as const;
export type ResearchArchiveKind = (typeof RESEARCH_ARCHIVE_KINDS)[number];

/**
 * Reopens a live view as it was archived on this day (YYYY-MM-DD) instead of
 * fetching it. Reads stored data only, so it never charges credits.
 */
export const archiveAsOfSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

/**
 * Reuse rules for paid lookups: `refresh` buys a live copy now; `maxAgeDays`
 * only accepts a stored copy at most that old.
 */
export const researchFreshnessShape = {
  refresh: z.boolean().optional(),
  maxAgeDays: z.number().min(0).max(365).optional(),
};

export const listResearchArchiveSchema = z.object({
  projectId: z.string().min(1),
  kinds: z.array(z.enum(RESEARCH_ARCHIVE_KINDS)).max(20).optional(),
  target: z.string().trim().min(1).max(2048).optional(),
  from: z.string().max(40).optional(),
  before: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const researchHistoryInputSchema = z.object({
  projectId: z.string().min(1),
  // Defaults to the project's domain plus its saved competitors.
  domains: z.array(z.string().trim().min(1).max(255)).max(25).optional(),
  // Defaults to the project's saved keywords.
  keywords: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  months: z
    .union(RESEARCH_HISTORY_MONTHS.map((months) => z.literal(months)))
    .default(12),
  // Matches the default backlinks scope for a bare domain.
  includeSubdomains: z.boolean().default(true),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().trim().min(2).max(10).optional(),
});
export type ResearchHistoryInput = z.input<typeof researchHistoryInputSchema>;

export const projectIdInputSchema = z.object({ projectId: z.string().min(1) });

export const setResearchSnapshotScheduleSchema = z.object({
  projectId: z.string().min(1),
  // Null turns the schedule off.
  interval: z.enum(RESEARCH_SNAPSHOT_INTERVALS).nullable(),
  includeKeywords: z.boolean().default(true),
});

export const rankCheckSerpSchema = z.object({
  keyword: z.string(),
  device: z.enum(["desktop", "mobile"]),
  position: z.number().nullable(),
  url: z.string().nullable(),
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

/** The view parameters archived with each rank-check SERP. */
export const rankCheckSerpParamsSchema = z.object({
  configId: z.string(),
  trackingKeywordId: z.string(),
  device: z.enum(["desktop", "mobile"]),
});
