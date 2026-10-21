import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";
import { reports } from "./reports.schema";

// ============================================================================
// Research history: dated snapshots of provider research results, so a project
// can chart its own domain against competitors over time. Rows are written by
// every lookup made inside a project (cached results included) and by the
// scheduled snapshot job. One row per subject per UTC day of the provider fetch
// (`captured_on`); a later capture on the same day replaces the earlier one. No FK to competitors or saved keywords, so
// history survives their removal; the projects cascade deletes it.
// ============================================================================

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const domainSnapshots = sqliteTable(
  "domain_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    // YYYY-MM-DD (UTC): the dedupe key and the chart's x-axis.
    capturedOn: text("captured_on").notNull(),
    organicTraffic: integer("organic_traffic"),
    organicKeywords: integer("organic_keywords"),
    top3Keywords: integer("top3_keywords"),
    top10Keywords: integer("top10_keywords"),
    capturedAt: text("captured_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("domain_snapshots_unique_day").on(
      table.projectId,
      table.domain,
      table.locationCode,
      table.languageCode,
      table.capturedOn,
    ),
  ],
);

export const domainBacklinkSnapshots = sqliteTable(
  "domain_backlink_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    // Domain and subdomain-inclusive lookups count different link sets, so they
    // are separate series.
    includeSubdomains: integer("include_subdomains", {
      mode: "boolean",
    }).notNull(),
    capturedOn: text("captured_on").notNull(),
    rank: integer("rank"),
    backlinks: integer("backlinks"),
    referringDomains: integer("referring_domains"),
    referringPages: integer("referring_pages"),
    brokenBacklinks: integer("broken_backlinks"),
    newBacklinks: integer("new_backlinks"),
    lostBacklinks: integer("lost_backlinks"),
    newReferringDomains: integer("new_referring_domains"),
    lostReferringDomains: integer("lost_referring_domains"),
    spamScore: integer("spam_score"),
    // Ahrefs' free Domain Rating at capture time (null when unrated).
    domainRating: integer("domain_rating"),
    capturedAt: text("captured_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("domain_backlink_snapshots_unique_day").on(
      table.projectId,
      table.domain,
      table.includeSubdomains,
      table.capturedOn,
    ),
  ],
);

export const keywordMetricSnapshots = sqliteTable(
  "keyword_metric_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    capturedOn: text("captured_on").notNull(),
    searchVolume: integer("search_volume"),
    cpc: real("cpc"),
    competition: real("competition"),
    keywordDifficulty: integer("keyword_difficulty"),
    capturedAt: text("captured_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("keyword_metric_snapshots_unique_day").on(
      table.projectId,
      table.keyword,
      table.locationCode,
      table.languageCode,
      table.capturedOn,
    ),
  ],
);

// One optional schedule per project. The scheduled job snapshots the project's
// own domain and its saved competitors (domain overview + backlinks) in the
// schedule's market and, when `include_keywords` is set, refreshes the metrics
// of every saved keyword.
export const researchSnapshotSchedules = sqliteTable(
  "research_snapshot_schedules",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    // "weekly" | "monthly"; deleting the row turns the schedule off.
    interval: text("interval").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    includeKeywords: integer("include_keywords", { mode: "boolean" })
      .notNull()
      .default(true),
    nextCheckAt: text("next_check_at").notNull(),
    lastCheckedAt: text("last_checked_at"),
    // Why the last due tick did not capture (e.g. "plan_required"); cleared on
    // a successful capture.
    lastSkipReason: text("last_skip_reason"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    index("research_snapshot_schedules_due_idx").on(table.nextCheckAt),
  ],
);

// Archive of full research results: every fresh (non-cached) Domain Overview,
// Backlinks, Keyword Research and SERP lookup, and every rank check's SERP, so
// a past view can be reopened exactly as it was fetched. The result itself is
// an immutable JSON object in R2 at `r2_key`; this row indexes it.
export const researchArchiveEntries = sqliteTable(
  "research_archive_entries",
  {
    // Derived from (project, view key, fetched at), so a retried write is a
    // no-op instead of a duplicate.
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // e.g. "domain_keywords", "backlinks_referring_domains", "rank_check_serp".
    kind: text("kind").notNull(),
    // The looked-up domain, URL or keyword, as displayed.
    target: text("target").notNull(),
    // The live view's cache key: reopening a view "as of" a date looks up the
    // same key it would read from the cache.
    viewKey: text("view_key").notNull(),
    // The request parameters (page, sort, filters, device...) for display.
    // Opaque and immutable, so JSON is fine here.
    params: text("params").notNull(),
    locationCode: integer("location_code"),
    languageCode: text("language_code"),
    // "app" | "mcp" | "schedule"
    origin: text("origin").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    r2Key: text("r2_key").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
  },
  (table) => [
    index("research_archive_target_idx").on(
      table.projectId,
      table.kind,
      table.target,
      table.fetchedAt,
    ),
    index("research_archive_view_idx").on(
      table.projectId,
      table.viewKey,
      table.fetchedAt,
    ),
    index("research_archive_project_fetched_idx").on(
      table.projectId,
      table.fetchedAt,
    ),
    // Retention sweeps the oldest entries across projects.
    index("research_archive_fetched_idx").on(table.fetchedAt),
  ],
);

// Search Console history, synced daily from the project's connected property
// so it outlives Google's 16-month window and can be read without calling
// Google. One row per day for the site, and for its top queries and pages
// (`gsc_daily_rows.dimension` is "query" or "page"). Dates are the property's
// GSC dates (YYYY-MM-DD); only finalized days are stored.
export const gscDailyTotals = sqliteTable(
  "gsc_daily_totals",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    ctr: real("ctr").notNull(),
    position: real("position").notNull(),
  },
  (table) => [
    uniqueIndex("gsc_daily_totals_day").on(table.projectId, table.date),
  ],
);

export const gscDailyRows = sqliteTable(
  "gsc_daily_rows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    dimension: text("dimension").notNull(),
    value: text("value").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    ctr: real("ctr").notNull(),
    position: real("position").notNull(),
  },
  (table) => [
    uniqueIndex("gsc_daily_rows_day").on(
      table.projectId,
      table.dimension,
      table.value,
      table.date,
    ),
    index("gsc_daily_rows_project_date_idx").on(
      table.projectId,
      table.dimension,
      table.date,
    ),
  ],
);

// Which archived results a report was built from, so updating or checking a
// report can reuse that exact data instead of buying it again.
export const reportSources = sqliteTable(
  "report_sources",
  {
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    archiveEntryId: text("archive_entry_id")
      .notNull()
      .references(() => researchArchiveEntries.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("report_sources_pair").on(table.reportId, table.archiveEntryId),
  ],
);
