import { z } from "zod";

export const RESEARCH_SNAPSHOT_INTERVALS = ["weekly", "monthly"] as const;
export type ResearchSnapshotInterval =
  (typeof RESEARCH_SNAPSHOT_INTERVALS)[number];

export const RESEARCH_HISTORY_MONTHS = [3, 6, 12] as const;

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
