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
