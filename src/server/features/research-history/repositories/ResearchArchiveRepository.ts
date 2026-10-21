import { and, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import { researchArchiveEntries } from "@/db/schema";

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

export const ResearchArchiveRepository = {
  insertEntry,
  findViewAt,
  getEntry,
  listEntries,
  listExpired,
  deleteEntries,
} as const;
