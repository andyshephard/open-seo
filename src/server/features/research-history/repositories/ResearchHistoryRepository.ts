import { and, asc, eq, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { sort } from "remeda";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import {
  domainBacklinkSnapshots,
  domainSnapshots,
  keywordMetricSnapshots,
  projects,
  researchSnapshotSchedules,
} from "@/db/schema";

type DomainSnapshotRow = typeof domainSnapshots.$inferInsert;
type BacklinkSnapshotRow = typeof domainBacklinkSnapshots.$inferInsert;
type KeywordSnapshotRow = typeof keywordMetricSnapshots.$inferInsert;
type ScheduleRow = typeof researchSnapshotSchedules.$inferInsert;

// D1 binds at most ~100 parameters per statement; keep IN lists well under it.
const IN_LIST_CHUNK = 50;

// Every write is an upsert on the per-day key: a retry or a second lookup on
// the same day replaces the day's row instead of duplicating it.

async function upsertDomainSnapshot(row: DomainSnapshotRow) {
  await db
    .insert(domainSnapshots)
    .values(row)
    .onConflictDoUpdate({
      target: [
        domainSnapshots.projectId,
        domainSnapshots.domain,
        domainSnapshots.locationCode,
        domainSnapshots.languageCode,
        domainSnapshots.capturedOn,
      ],
      set: {
        organicTraffic: row.organicTraffic,
        organicKeywords: row.organicKeywords,
        top3Keywords: row.top3Keywords,
        top10Keywords: row.top10Keywords,
        capturedAt: row.capturedAt,
      },
    });
}

async function upsertBacklinkSnapshot(row: BacklinkSnapshotRow) {
  await db
    .insert(domainBacklinkSnapshots)
    .values(row)
    .onConflictDoUpdate({
      target: [
        domainBacklinkSnapshots.projectId,
        domainBacklinkSnapshots.domain,
        domainBacklinkSnapshots.includeSubdomains,
        domainBacklinkSnapshots.capturedOn,
      ],
      set: {
        rank: row.rank,
        backlinks: row.backlinks,
        referringDomains: row.referringDomains,
        referringPages: row.referringPages,
        brokenBacklinks: row.brokenBacklinks,
        newBacklinks: row.newBacklinks,
        lostBacklinks: row.lostBacklinks,
        newReferringDomains: row.newReferringDomains,
        lostReferringDomains: row.lostReferringDomains,
        spamScore: row.spamScore,
        capturedAt: row.capturedAt,
      },
    });
}

async function upsertKeywordSnapshots(rows: KeywordSnapshotRow[]) {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(keywordMetricSnapshots)
      .values(row)
      .onConflictDoUpdate({
        target: [
          keywordMetricSnapshots.projectId,
          keywordMetricSnapshots.keyword,
          keywordMetricSnapshots.locationCode,
          keywordMetricSnapshots.languageCode,
          keywordMetricSnapshots.capturedOn,
        ],
        set: {
          searchVolume: row.searchVolume,
          cpc: row.cpc,
          competition: row.competition,
          keywordDifficulty: row.keywordDifficulty,
          capturedAt: row.capturedAt,
        },
      }),
  );
}

async function inChunks<T>(
  values: string[],
  read: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < values.length; offset += IN_LIST_CHUNK) {
    rows.push(...(await read(values.slice(offset, offset + IN_LIST_CHUNK))));
  }
  return rows;
}

async function listDomainSnapshots(input: {
  projectId: string;
  domains: string[];
  locationCode: number;
  languageCode: string;
  since: string;
}) {
  return inChunks(input.domains, (domains) =>
    db
      .select()
      .from(domainSnapshots)
      .where(
        and(
          eq(domainSnapshots.projectId, input.projectId),
          inArray(domainSnapshots.domain, domains),
          eq(domainSnapshots.locationCode, input.locationCode),
          eq(domainSnapshots.languageCode, input.languageCode),
          gte(domainSnapshots.capturedOn, input.since),
        ),
      )
      .orderBy(asc(domainSnapshots.capturedOn)),
  );
}

async function listBacklinkSnapshots(input: {
  projectId: string;
  domains: string[];
  includeSubdomains: boolean;
  since: string;
}) {
  return inChunks(input.domains, (domains) =>
    db
      .select()
      .from(domainBacklinkSnapshots)
      .where(
        and(
          eq(domainBacklinkSnapshots.projectId, input.projectId),
          inArray(domainBacklinkSnapshots.domain, domains),
          eq(
            domainBacklinkSnapshots.includeSubdomains,
            input.includeSubdomains,
          ),
          gte(domainBacklinkSnapshots.capturedOn, input.since),
        ),
      )
      .orderBy(asc(domainBacklinkSnapshots.capturedOn)),
  );
}

async function listKeywordSnapshots(input: {
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
  since: string;
}) {
  return inChunks(input.keywords, (keywords) =>
    db
      .select()
      .from(keywordMetricSnapshots)
      .where(
        and(
          eq(keywordMetricSnapshots.projectId, input.projectId),
          inArray(keywordMetricSnapshots.keyword, keywords),
          eq(keywordMetricSnapshots.locationCode, input.locationCode),
          eq(keywordMetricSnapshots.languageCode, input.languageCode),
          gte(keywordMetricSnapshots.capturedOn, input.since),
        ),
      )
      .orderBy(asc(keywordMetricSnapshots.capturedOn)),
  );
}

/** Domains with any history in the project, for the history picker. */
async function listCapturedDomains(projectId: string) {
  const rows = await db
    .selectDistinct({ domain: domainSnapshots.domain })
    .from(domainSnapshots)
    .where(eq(domainSnapshots.projectId, projectId))
    .union(
      db
        .selectDistinct({ domain: domainBacklinkSnapshots.domain })
        .from(domainBacklinkSnapshots)
        .where(eq(domainBacklinkSnapshots.projectId, projectId)),
    );
  return sort(
    rows.map((row) => row.domain),
    (a, b) => a.localeCompare(b),
  );
}

/** Retention: drops the project's snapshots captured before `capturedOn`. */
async function pruneProjectBefore(projectId: string, capturedOn: string) {
  await db
    .delete(domainSnapshots)
    .where(
      and(
        eq(domainSnapshots.projectId, projectId),
        lt(domainSnapshots.capturedOn, capturedOn),
      ),
    );
  await db
    .delete(domainBacklinkSnapshots)
    .where(
      and(
        eq(domainBacklinkSnapshots.projectId, projectId),
        lt(domainBacklinkSnapshots.capturedOn, capturedOn),
      ),
    );
  await db
    .delete(keywordMetricSnapshots)
    .where(
      and(
        eq(keywordMetricSnapshots.projectId, projectId),
        lt(keywordMetricSnapshots.capturedOn, capturedOn),
      ),
    );
}

async function getSchedule(projectId: string) {
  const [row] = await db
    .select()
    .from(researchSnapshotSchedules)
    .where(eq(researchSnapshotSchedules.projectId, projectId));
  return row ?? null;
}

async function upsertSchedule(row: ScheduleRow) {
  const { projectId: _projectId, createdAt: _createdAt, ...set } = row;
  await db
    .insert(researchSnapshotSchedules)
    .values(row)
    .onConflictDoUpdate({ target: researchSnapshotSchedules.projectId, set });
}

async function deleteSchedule(projectId: string) {
  await db
    .delete(researchSnapshotSchedules)
    .where(eq(researchSnapshotSchedules.projectId, projectId));
}

/** Due schedules of live projects, oldest first. */
async function listDueSchedules(now: string) {
  return db
    .select({
      schedule: researchSnapshotSchedules,
      organizationId: projects.organizationId,
      domain: projects.domain,
    })
    .from(researchSnapshotSchedules)
    .innerJoin(projects, eq(projects.id, researchSnapshotSchedules.projectId))
    .where(
      and(
        lte(researchSnapshotSchedules.nextCheckAt, now),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(asc(researchSnapshotSchedules.nextCheckAt))
    .limit(50);
}

/**
 * Compare-and-set on `next_check_at`: only one tick advances a due schedule,
 * so overlapping ticks never capture the same project twice.
 */
async function claimDueSchedule(input: {
  projectId: string;
  observedNextCheckAt: string;
  nextCheckAt: string;
}) {
  const claimed = await db
    .update(researchSnapshotSchedules)
    .set({
      nextCheckAt: input.nextCheckAt,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(researchSnapshotSchedules.projectId, input.projectId),
        eq(researchSnapshotSchedules.nextCheckAt, input.observedNextCheckAt),
      ),
    )
    .returning({ projectId: researchSnapshotSchedules.projectId });
  return claimed.length > 0;
}

async function recordScheduleResult(
  projectId: string,
  values: { lastCheckedAt?: string; lastSkipReason: string | null },
) {
  await db
    .update(researchSnapshotSchedules)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(researchSnapshotSchedules.projectId, projectId));
}

export const ResearchHistoryRepository = {
  upsertDomainSnapshot,
  upsertBacklinkSnapshot,
  upsertKeywordSnapshots,
  listDomainSnapshots,
  listBacklinkSnapshots,
  listKeywordSnapshots,
  listCapturedDomains,
  pruneProjectBefore,
  getSchedule,
  upsertSchedule,
  deleteSchedule,
  listDueSchedules,
  claimDueSchedule,
  recordScheduleResult,
} as const;
