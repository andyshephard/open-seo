import { and, desc, eq, gte, lte, max, sql, sum } from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import { gscDailyRows, gscDailyTotals } from "@/db/schema";

type TotalsRow = typeof gscDailyTotals.$inferInsert;
type DailyRow = typeof gscDailyRows.$inferInsert;

// Upserts on the per-day key, so re-syncing a day replaces it.

async function upsertTotals(rows: TotalsRow[]) {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(gscDailyTotals)
      .values(row)
      .onConflictDoUpdate({
        target: [gscDailyTotals.projectId, gscDailyTotals.date],
        set: {
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        },
      }),
  );
}

async function upsertRows(rows: DailyRow[]) {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(gscDailyRows)
      .values(row)
      .onConflictDoUpdate({
        target: [
          gscDailyRows.projectId,
          gscDailyRows.dimension,
          gscDailyRows.value,
          gscDailyRows.date,
        ],
        set: {
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        },
      }),
  );
}

async function latestTotalsDate(projectId: string) {
  const [row] = await db
    .select({ date: max(gscDailyTotals.date) })
    .from(gscDailyTotals)
    .where(eq(gscDailyTotals.projectId, projectId));
  return row?.date ?? null;
}

async function latestRowsDate(projectId: string) {
  const [row] = await db
    .select({ date: max(gscDailyRows.date) })
    .from(gscDailyRows)
    .where(eq(gscDailyRows.projectId, projectId));
  return row?.date ?? null;
}

async function listTotals(projectId: string, from: string, to: string) {
  return db
    .select()
    .from(gscDailyTotals)
    .where(
      and(
        eq(gscDailyTotals.projectId, projectId),
        gte(gscDailyTotals.date, from),
        lte(gscDailyTotals.date, to),
      ),
    )
    .orderBy(gscDailyTotals.date);
}

/**
 * The top queries or pages over a date range: summed clicks and impressions,
 * and position averaged by impressions (how Search Console aggregates it).
 */
async function topRows(input: {
  projectId: string;
  dimension: "query" | "page";
  from: string;
  to: string;
  limit: number;
  value?: string;
}) {
  const clicks = sum(gscDailyRows.clicks).mapWith(Number);
  return db
    .select({
      value: gscDailyRows.value,
      clicks,
      impressions: sum(gscDailyRows.impressions).mapWith(Number),
      position:
        sql<number>`sum(${gscDailyRows.position} * ${gscDailyRows.impressions}) / nullif(sum(${gscDailyRows.impressions}), 0)`.mapWith(
          Number,
        ),
    })
    .from(gscDailyRows)
    .where(
      and(
        eq(gscDailyRows.projectId, input.projectId),
        eq(gscDailyRows.dimension, input.dimension),
        gte(gscDailyRows.date, input.from),
        lte(gscDailyRows.date, input.to),
        input.value ? eq(gscDailyRows.value, input.value) : undefined,
      ),
    )
    .groupBy(gscDailyRows.value)
    .orderBy(desc(clicks))
    .limit(input.limit);
}

export const SearchHistoryRepository = {
  upsertTotals,
  upsertRows,
  latestTotalsDate,
  latestRowsDate,
  listTotals,
  topRows,
} as const;
