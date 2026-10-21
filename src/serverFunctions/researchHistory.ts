import { createServerFn } from "@tanstack/react-start";
import { ResearchHistoryRepository } from "@/server/features/research-history/repositories/ResearchHistoryRepository";
import { getResearchHistory as loadResearchHistory } from "@/server/features/research-history/services/researchHistory";
import {
  captureProjectSnapshot,
  setSnapshotSchedule,
} from "@/server/features/research-history/services/researchSnapshots";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  projectIdInputSchema,
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
