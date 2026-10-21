import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ResearchHistoryRepository } from "@/server/features/research-history/repositories/ResearchHistoryRepository";
import { getResearchHistory as loadResearchHistory } from "@/server/features/research-history/services/researchHistory";
import {
  captureProjectSnapshot,
  setSnapshotSchedule,
} from "@/server/features/research-history/services/researchSnapshots";
import {
  getArchiveEntry,
  listArchive,
} from "@/server/features/research-history/services/researchArchive";
import { getSearchConsoleHistory as loadSearchConsoleHistory } from "@/server/features/research-history/services/searchConsoleHistory";
import { AppError } from "@/server/lib/errors";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  listResearchArchiveSchema,
  projectIdInputSchema,
  rankCheckSerpSchema,
  searchConsoleHistorySchema,
  researchHistoryInputSchema,
  setResearchSnapshotScheduleSchema,
} from "@/types/schemas/researchHistory";

export const getResearchHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(researchHistoryInputSchema)
  .handler(async ({ data, context }) =>
    loadResearchHistory(context.project, data),
  );

export const getResearchSnapshotSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectIdInputSchema)
  .handler(async ({ context }) =>
    ResearchHistoryRepository.getSchedule(context.projectId),
  );

export const setResearchSnapshotSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setResearchSnapshotScheduleSchema)
  .handler(async ({ data, context }) =>
    setSnapshotSchedule({
      projectId: context.projectId,
      interval: data.interval,
      includeKeywords: data.includeKeywords,
      locationCode: context.project.locationCode,
      languageCode: context.project.languageCode,
    }),
  );

/** Paid: runs the same lookups as one scheduled snapshot, right now. */
export const captureResearchSnapshotNow = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    setResearchSnapshotScheduleSchema
      .pick({ includeKeywords: true })
      .extend(projectIdInputSchema.shape),
  )
  .handler(async ({ data, context }) =>
    captureProjectSnapshot(
      {
        organizationId: context.organizationId,
        userId: context.userId,
        userEmail: context.userEmail,
        projectId: context.projectId,
      },
      {
        domain: context.project.domain,
        locationCode: context.project.locationCode,
        languageCode: context.project.languageCode,
        includeKeywords: data.includeKeywords,
      },
    ),
  );

export const listResearchArchive = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listResearchArchiveSchema)
  .handler(async ({ data, context }) =>
    listArchive({ ...data, projectId: context.projectId }),
  );

/** One archived rank-check results page, as the check saw it. */
export const getRankCheckSerp = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectIdInputSchema.extend({ id: z.string().min(1).max(64) }))
  .handler(async ({ data, context }) => {
    const entry = await getArchiveEntry(context.projectId, data.id);
    if (entry.kind !== "rank_check_serp")
      throw new AppError("NOT_FOUND", "Archived SERP not found.");
    return {
      fetchedAt: entry.fetchedAt,
      ...rankCheckSerpSchema.parse(entry.result),
    };
  });

/**
 * One archived result for the in-app viewer. The result is returned as JSON
 * text: it is arbitrary provider data, rendered generically by the client.
 */
export const getResearchArchiveEntry = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectIdInputSchema.extend({ id: z.string().min(1).max(64) }))
  .handler(async ({ data, context }) => {
    const { result, ...entry } = await getArchiveEntry(
      context.projectId,
      data.id,
    );
    return { ...entry, resultJson: JSON.stringify(result ?? null) };
  });

export const getSearchConsoleHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(searchConsoleHistorySchema)
  .handler(async ({ data, context }) =>
    loadSearchConsoleHistory({ ...data, projectId: context.projectId }),
  );
