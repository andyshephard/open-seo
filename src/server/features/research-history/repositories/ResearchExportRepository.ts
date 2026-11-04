import { and, asc, eq, getTableColumns, gt, lte, or } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "@/db";
import {
  domainBacklinkSnapshots,
  domainSnapshots,
  exportDeletions,
  gscDailyRows,
  gscDailyTotals,
  keywordMetricSnapshots,
  projects,
  researchArchiveEntries,
} from "@/db/schema";

// Keyset pages over the research history tables for the export API, ordered
// by (written_at, key). `key` is the row's unique tiebreaker within a project:
// the id, or the date for gsc_daily_totals (one row per project per day).

type ExportTable = {
  table: SQLiteTable;
  projectId: SQLiteColumn;
  writtenAt: SQLiteColumn;
  key: SQLiteColumn;
  keyType: "number" | "string";
  // Storage internals left out of the export.
  omit?: string[];
};

export const EXPORT_TABLES = {
  domain_snapshots: {
    table: domainSnapshots,
    projectId: domainSnapshots.projectId,
    writtenAt: domainSnapshots.writtenAt,
    key: domainSnapshots.id,
    keyType: "number",
  },
  domain_backlink_snapshots: {
    table: domainBacklinkSnapshots,
    projectId: domainBacklinkSnapshots.projectId,
    writtenAt: domainBacklinkSnapshots.writtenAt,
    key: domainBacklinkSnapshots.id,
    keyType: "number",
  },
  keyword_metric_snapshots: {
    table: keywordMetricSnapshots,
    projectId: keywordMetricSnapshots.projectId,
    writtenAt: keywordMetricSnapshots.writtenAt,
    key: keywordMetricSnapshots.id,
    keyType: "number",
  },
  gsc_daily_totals: {
    table: gscDailyTotals,
    projectId: gscDailyTotals.projectId,
    writtenAt: gscDailyTotals.writtenAt,
    key: gscDailyTotals.date,
    keyType: "string",
  },
  gsc_daily_rows: {
    table: gscDailyRows,
    projectId: gscDailyRows.projectId,
    writtenAt: gscDailyRows.writtenAt,
    key: gscDailyRows.id,
    keyType: "number",
  },
  research_archive_entries: {
    table: researchArchiveEntries,
    projectId: researchArchiveEntries.projectId,
    writtenAt: researchArchiveEntries.writtenAt,
    key: researchArchiveEntries.id,
    keyType: "string",
    // The payload's storage path; the export links its own payload route.
    omit: ["r2_key"],
  },
  // Not research data: the feed of deletes from the tables above.
  deletions: {
    table: exportDeletions,
    projectId: exportDeletions.projectId,
    writtenAt: exportDeletions.writtenAt,
    key: exportDeletions.id,
    keyType: "number",
  },
} satisfies Record<string, ExportTable>;

export type ExportTableName = keyof typeof EXPORT_TABLES;

export type ExportCursor = { writtenAt: string; key: string | number };

/** Every column but the omitted ones, keyed by its SQL (snake_case) name. */
function exportColumns(spec: ExportTable) {
  return Object.fromEntries(
    Object.values(getTableColumns(spec.table))
      .filter((column) => !spec.omit?.includes(column.name))
      .map((column) => [column.name, column]),
  );
}

/**
 * Up to `limit` rows of one project written after `after` and no later than
 * `settledBefore`, oldest write first.
 */
async function readPage(input: {
  table: ExportTableName;
  projectId: string;
  after: ExportCursor | null;
  settledBefore: string;
  limit: number;
}) {
  const spec: ExportTable = EXPORT_TABLES[input.table];
  const { after } = input;
  const rows = await db
    .select(exportColumns(spec))
    .from(spec.table)
    .where(
      and(
        eq(spec.projectId, input.projectId),
        lte(spec.writtenAt, input.settledBefore),
        after
          ? or(
              gt(spec.writtenAt, after.writtenAt),
              and(eq(spec.writtenAt, after.writtenAt), gt(spec.key, after.key)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(spec.writtenAt), asc(spec.key))
    .limit(input.limit);
  return rows.map((row) => ({
    row,
    cursor: {
      writtenAt: String(row[spec.writtenAt.name]),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the key column is an integer id or a text column (keyType)
      key: row[spec.key.name] as string | number,
    },
  }));
}

/** Projects of the organization, archived ones included (their data is). */
async function listProjects(organizationId: string) {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      domain: projects.domain,
      created_at: projects.createdAt,
      archived_at: projects.archivedAt,
    })
    .from(projects)
    .where(eq(projects.organizationId, organizationId))
    .orderBy(asc(projects.createdAt), asc(projects.id));
}

async function projectInOrganization(
  projectId: string,
  organizationId: string,
) {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export const ResearchExportRepository = {
  readPage,
  listProjects,
  projectInOrganization,
} as const;
