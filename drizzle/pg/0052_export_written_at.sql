ALTER TABLE "domain_backlink_snapshots" ADD COLUMN "written_at" text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_snapshots" ADD COLUMN "written_at" text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE "gsc_daily_rows" ADD COLUMN "written_at" text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE "gsc_daily_totals" ADD COLUMN "written_at" text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE "keyword_metric_snapshots" ADD COLUMN "written_at" text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE "research_archive_entries" ADD COLUMN "written_at" text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
CREATE INDEX "domain_backlink_snapshots_written_idx" ON "domain_backlink_snapshots" USING btree ("project_id","written_at","id");--> statement-breakpoint
CREATE INDEX "domain_snapshots_written_idx" ON "domain_snapshots" USING btree ("project_id","written_at","id");--> statement-breakpoint
CREATE INDEX "gsc_daily_rows_written_idx" ON "gsc_daily_rows" USING btree ("project_id","written_at","id");--> statement-breakpoint
CREATE INDEX "gsc_daily_totals_written_idx" ON "gsc_daily_totals" USING btree ("project_id","written_at","date");--> statement-breakpoint
CREATE INDEX "keyword_metric_snapshots_written_idx" ON "keyword_metric_snapshots" USING btree ("project_id","written_at","id");--> statement-breakpoint
CREATE INDEX "research_archive_entries_written_idx" ON "research_archive_entries" USING btree ("project_id","written_at","id");