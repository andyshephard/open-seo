import { and, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { reportSources, researchArchiveEntries } from "@/db/schema";

type ArchiveRow = typeof researchArchiveEntries.$inferInsert;

async function insertEntry(row: ArchiveRow) {
  await db.insert(researchArchiveEntries).values(row).onConflictDoNothing();
}

/** The newest capture of a view fetched at or before `until`. */
async function findViewAt(projectId: string, viewKey: string, until: string) {
  const [row] = await db
    .select()
    .from(researchArchiveEntries)
    .where(
      and(
        eq(researchArchiveEntries.projectId, projectId),
        eq(researchArchiveEntries.viewKey, viewKey),
        lte(researchArchiveEntries.fetchedAt, until),
      ),
    )
    .orderBy(desc(researchArchiveEntries.fetchedAt))
    .limit(1);
  return row ?? null;
}

async function getEntry(projectId: string, id: string) {
  const [row] = await db
    .select()
    .from(researchArchiveEntries)
    .where(
      and(
        eq(researchArchiveEntries.projectId, projectId),
        eq(researchArchiveEntries.id, id),
      ),
    );
  return row ?? null;
}

/** Newest first; `before` pages backwards by fetched time. */
async function listEntries(input: {
  projectId: string;
  kinds?: string[];
  targets?: string[];
  from?: string;
  before?: string;
  limit: number;
}) {
  return db
    .select()
    .from(researchArchiveEntries)
    .where(
      and(
        eq(researchArchiveEntries.projectId, input.projectId),
        input.kinds?.length
          ? inArray(researchArchiveEntries.kind, input.kinds)
          : undefined,
        input.targets?.length
          ? inArray(researchArchiveEntries.target, input.targets)
          : undefined,
        input.from
          ? gte(researchArchiveEntries.fetchedAt, input.from)
          : undefined,
        input.before
          ? lt(researchArchiveEntries.fetchedAt, input.before)
          : undefined,
      ),
    )
    .orderBy(
      desc(researchArchiveEntries.fetchedAt),
      desc(researchArchiveEntries.id),
    )
    .limit(input.limit);
}

/** Up to `limit` entries older than `cutoff`, across projects, oldest first. */
async function listExpired(cutoff: string, limit: number) {
  return db
    .select({
      id: researchArchiveEntries.id,
      r2Key: researchArchiveEntries.r2Key,
    })
    .from(researchArchiveEntries)
    .where(lt(researchArchiveEntries.fetchedAt, cutoff))
    .orderBy(researchArchiveEntries.fetchedAt)
    .limit(limit);
}

async function deleteEntries(ids: string[]) {
  if (ids.length === 0) return;
  await db
    .delete(researchArchiveEntries)
    .where(inArray(researchArchiveEntries.id, ids));
}

/**
 * Replaces a report's sources with the given archive entries. Only entries of
 * the same project are linked; the caller has verified the report is too.
 */
async function setReportSources(input: {
  projectId: string;
  reportId: string;
  entryIds: string[];
}) {
  const owned =
    input.entryIds.length === 0
      ? []
      : await db
          .select({ id: researchArchiveEntries.id })
          .from(researchArchiveEntries)
          .where(
            and(
              eq(researchArchiveEntries.projectId, input.projectId),
              inArray(researchArchiveEntries.id, input.entryIds.slice(0, 50)),
            ),
          );
  await runBatch((tx) => [
    tx.delete(reportSources).where(eq(reportSources.reportId, input.reportId)),
    ...owned.map((entry) =>
      tx
        .insert(reportSources)
        .values({ reportId: input.reportId, archiveEntryId: entry.id })
        .onConflictDoNothing(),
    ),
  ]);
  return owned.length;
}

async function listReportSources(projectId: string, reportId: string) {
  return db
    .select({ entry: researchArchiveEntries })
    .from(reportSources)
    .innerJoin(
      researchArchiveEntries,
      eq(researchArchiveEntries.id, reportSources.archiveEntryId),
    )
    .where(
      and(
        eq(reportSources.reportId, reportId),
        eq(researchArchiveEntries.projectId, projectId),
      ),
    )
    .orderBy(desc(researchArchiveEntries.fetchedAt));
}

export const ResearchArchiveRepository = {
  setReportSources,
  listReportSources,
  insertEntry,
  findViewAt,
  getEntry,
  listEntries,
  listExpired,
  deleteEntries,
} as const;
