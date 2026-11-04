CREATE TABLE "report_sources" (
	"report_id" text NOT NULL,
	"archive_entry_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_sources" ADD CONSTRAINT "report_sources_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sources" ADD CONSTRAINT "report_sources_archive_entry_id_research_archive_entries_id_fk" FOREIGN KEY ("archive_entry_id") REFERENCES "public"."research_archive_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_sources_pair" ON "report_sources" USING btree ("report_id","archive_entry_id");