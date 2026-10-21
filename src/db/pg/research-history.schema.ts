import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// Postgres mirror of the research history tables. Column notes: see
// ../research-history.schema.ts. Large provider counts are bigint here; SQLite
// integers are already 64-bit.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const domainSnapshots = pgTable(
  "domain_snapshots",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    capturedOn: text("captured_on").notNull(),
    organicTraffic: bigint("organic_traffic", { mode: "number" }),
    organicKeywords: bigint("organic_keywords", { mode: "number" }),
    top3Keywords: bigint("top3_keywords", { mode: "number" }),
    top10Keywords: bigint("top10_keywords", { mode: "number" }),
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

export const domainBacklinkSnapshots = pgTable(
  "domain_backlink_snapshots",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    includeSubdomains: boolean("include_subdomains").notNull(),
    capturedOn: text("captured_on").notNull(),
    rank: integer("rank"),
    backlinks: bigint("backlinks", { mode: "number" }),
    referringDomains: bigint("referring_domains", { mode: "number" }),
    referringPages: bigint("referring_pages", { mode: "number" }),
    brokenBacklinks: bigint("broken_backlinks", { mode: "number" }),
    newBacklinks: bigint("new_backlinks", { mode: "number" }),
    lostBacklinks: bigint("lost_backlinks", { mode: "number" }),
    newReferringDomains: bigint("new_referring_domains", { mode: "number" }),
    lostReferringDomains: bigint("lost_referring_domains", { mode: "number" }),
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

export const keywordMetricSnapshots = pgTable(
  "keyword_metric_snapshots",
  {
    id: serial("id").primaryKey(),
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

export const researchSnapshotSchedules = pgTable(
  "research_snapshot_schedules",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    interval: text("interval").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    includeKeywords: boolean("include_keywords").notNull().default(true),
    nextCheckAt: text("next_check_at").notNull(),
    lastCheckedAt: text("last_checked_at"),
    lastSkipReason: text("last_skip_reason"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    index("research_snapshot_schedules_due_idx").on(table.nextCheckAt),
  ],
);

export const researchArchiveEntries = pgTable(
  "research_archive_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    target: text("target").notNull(),
    viewKey: text("view_key").notNull(),
    params: text("params").notNull(),
    locationCode: integer("location_code"),
    languageCode: text("language_code"),
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
    index("research_archive_fetched_idx").on(table.fetchedAt),
  ],
);
