import { unique } from "remeda";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { BacklinksService } from "@/server/features/backlinks/services/BacklinksService";
import { DomainService } from "@/server/features/domain/services/DomainService";
import { KeywordResearchService } from "@/server/features/keywords/services/KeywordResearchService";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { computeNextCheckAt } from "@/shared/rank-tracking";
import type { CacheFreshness } from "@/server/lib/r2-cache";
import {
  backlinksRowsPageRequestSchema,
  referringDomainsPageRequestSchema,
  topPagesPageRequestSchema,
} from "@/types/schemas/backlinks";
import {
  domainKeywordsPageRequestSchema,
  domainPagesPageRequestSchema,
} from "@/types/schemas/domain";
import type { ResearchSnapshotInterval } from "@/types/schemas/researchHistory";
import { ResearchHistoryRepository as repo } from "../repositories/ResearchHistoryRepository";
import { pruneResearchArchive } from "./researchArchive";

// The project's own domain plus this many saved competitors per snapshot.
const MAX_COMPETITORS = 10;
const TICK_DEADLINE_MS = 2 * 60_000;
const RETENTION_MONTHS = 13;

/**
 * Snapshots the project's domain and saved competitors (domain overview and
 * backlinks) and, optionally, refreshes saved keyword metrics. The lookups go
 * through the normal services, so each result is cached, billed and recorded
 * in research history exactly like a lookup made in the app. One failed domain
 * does not stop the rest.
 */
export async function captureProjectSnapshot(
  customer: BillingCustomerContext & { projectId: string },
  input: {
    domain: string | null;
    locationCode: number;
    languageCode: string;
    includeKeywords: boolean;
    /** Snapshot now buys fresh data; the schedule accepts only today's. */
    freshness: CacheFreshness;
  },
) {
  const competitors = await ProjectContextRepository.listCompetitors(
    customer.projectId,
  );
  const domains = unique(
    [input.domain, ...competitors.map((row) => row.domain)].filter(
      (domain): domain is string => !!domain,
    ),
  ).slice(0, MAX_COMPETITORS + 1);

  const results = [];
  const market = {
    locationCode: input.locationCode,
    languageCode: input.languageCode,
  };
  for (const domain of domains) {
    // The summaries plus the first view of every table on the Domain
    // Overview and Backlinks pages, requested exactly as those pages request
    // them, so each snapshot opens there in full.
    const page = { projectId: customer.projectId, ...input.freshness };
    const domainView = { ...page, domain, ...market };
    const backlinksView = { ...page, target: domain };
    results.push(
      ...(await Promise.allSettled(
        [
          () => DomainService.getOverview(domainView, customer),
          () =>
            DomainService.getKeywordsPage(
              {
                ...domainKeywordsPageRequestSchema.parse(domainView),
                ...market,
              },
              customer,
            ),
          () =>
            DomainService.getPagesPage(
              { ...domainPagesPageRequestSchema.parse(domainView), ...market },
              customer,
            ),
          () => BacklinksService.profileOverview(backlinksView, customer),
          () =>
            BacklinksService.profileBacklinksPage(
              backlinksRowsPageRequestSchema.parse(backlinksView),
              customer,
              { hideSpam: true },
            ),
          () =>
            BacklinksService.profileReferringDomainsPage(
              referringDomainsPageRequestSchema.parse(backlinksView),
              customer,
              { hideSpam: false },
            ),
          () =>
            BacklinksService.profileTopPagesPage(
              topPagesPageRequestSchema.parse(backlinksView),
              customer,
            ),
          // Each lookup settles on its own, including a bad request.
        ].map(async (lookup) => lookup()),
      )),
    );
  }
  if (input.includeKeywords)
    results.push(
      ...(await Promise.allSettled([
        KeywordResearchService.refreshSavedKeywordMetrics(
          { projectId: customer.projectId, ...input.freshness },
          customer,
        ),
      ])),
    );

  const failures = results.filter((result) => result.status === "rejected");
  for (const failure of failures) {
    const error: unknown = failure.reason;
    console.error("[research-history] snapshot lookup failed", {
      projectId: customer.projectId,
      error,
    });
  }
  return { domains, failed: failures.length, total: results.length };
}

export async function setSnapshotSchedule(input: {
  projectId: string;
  interval: ResearchSnapshotInterval | null;
  includeKeywords: boolean;
  locationCode: number;
  languageCode: string;
}) {
  if (!input.interval) {
    await repo.deleteSchedule(input.projectId);
    return null;
  }
  const existing = await repo.getSchedule(input.projectId);
  const now = new Date().toISOString();
  await repo.upsertSchedule({
    projectId: input.projectId,
    interval: input.interval,
    includeKeywords: input.includeKeywords,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    // Keep the cadence anchor when only the options change.
    nextCheckAt:
      existing?.interval === input.interval
        ? existing.nextCheckAt
        : computeNextCheckAt(input.interval),
    lastSkipReason: existing?.lastSkipReason ?? null,
    lastCheckedAt: existing?.lastCheckedAt ?? null,
    updatedAt: now,
  });
  return repo.getSchedule(input.projectId);
}

function retentionCutoff(now: Date) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  return cutoff.toISOString().slice(0, 10);
}

/** Cron body: capture every due project, then prune its expired history. */
export async function runScheduledResearchSnapshots() {
  try {
    await pruneResearchArchive();
  } catch (error) {
    console.error("[research-history] archive retention sweep failed", error);
  }
  const deadline = Date.now() + TICK_DEADLINE_MS;
  for (const {
    schedule,
    organizationId,
    domain,
  } of await repo.listDueSchedules(new Date().toISOString())) {
    if (Date.now() >= deadline) break;
    const { projectId } = schedule;
    try {
      // Advance first, so a failing project moves on instead of staying due.
      const claimed = await repo.claimDueSchedule({
        projectId,
        observedNextCheckAt: schedule.nextCheckAt,
        nextCheckAt: computeNextCheckAt(
          schedule.interval === "monthly" ? "monthly" : "weekly",
          schedule.nextCheckAt,
        ),
      });
      if (!claimed) continue;
      const result = await captureProjectSnapshot(
        {
          organizationId,
          userId: "system",
          userEmail: "system@openseo.so",
          projectId,
          origin: "schedule",
        },
        {
          domain,
          locationCode: schedule.locationCode,
          languageCode: schedule.languageCode,
          includeKeywords: schedule.includeKeywords,
          // A week has passed, so stored results have mostly expired; reuse
          // only what another lookup already bought today.
          freshness: { maxAgeDays: 1 },
        },
      );
      await repo.recordScheduleResult(projectId, {
        lastCheckedAt: new Date().toISOString(),
        lastSkipReason:
          result.total === 0
            ? "Add a project domain or competitors to snapshot."
            : result.failed === result.total
              ? "Every lookup failed. Check your data provider balance."
              : null,
      });
      await repo.pruneProjectBefore(projectId, retentionCutoff(new Date()));
    } catch (error) {
      console.error("[research-history] scheduled snapshot failed", {
        projectId,
        error,
      });
      await repo
        .recordScheduleResult(projectId, {
          lastSkipReason: "The scheduled snapshot could not run.",
        })
        .catch(() => undefined);
    }
  }
}
