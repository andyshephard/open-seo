import { and, sql, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { exportDeletions } from "@/db/schema";
import type { ExportTableName } from "./ResearchExportRepository";

// Deletes of exported rows, recorded in the same batch as the delete so the
// export's deletions feed (/api/export/deletions) never misses one or lists
// one that did not happen.

type BatchExecutor = Parameters<Parameters<typeof runBatch>[0]>[0];

/** The exported tables rows can be deleted from. */
type DeletableExportTable = Exclude<ExportTableName, "deletions">;

/**
 * Which of a project's rows went: all of them, those dated before a day (the
 * table's day column: captured_on, or date for Search Console), or by key.
 */
type DeletionScope =
  | { all: true }
  | { before: string }
  | { ids: Array<string | number> };

/** The statement recording a delete, for the batch that runs it. */
export function recordDeletion(
  tx: BatchExecutor,
  projectId: string,
  table: DeletableExportTable,
  scope: DeletionScope,
) {
  return tx.insert(exportDeletions).values({
    projectId,
    tableName: table,
    scope: JSON.stringify(scope),
  });
}

/**
 * Deletes a project's rows matching `conditions` and records it, in one
 * batch. A delete that matches nothing records nothing. Returns whether rows
 * were deleted.
 */
export async function deleteRecorded(input: {
  table: SQLiteTable;
  name: DeletableExportTable;
  projectId: string;
  conditions: [SQL, ...SQL[]];
  scope: DeletionScope;
}) {
  const where = and(...input.conditions);
  const [match] = await db
    .select({ found: sql<number>`1` })
    .from(input.table)
    .where(where)
    .limit(1);
  if (!match) return false;
  await runBatch((tx) => [
    tx.delete(input.table).where(where),
    recordDeletion(tx, input.projectId, input.name, input.scope),
  ]);
  return true;
}
