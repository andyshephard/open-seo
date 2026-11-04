CREATE TABLE "research_archive_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"view_key" text NOT NULL,
	"params" text NOT NULL,
	"location_code" integer,
	"language_code" text,
	"origin" text NOT NULL,
	"fetched_at" text NOT NULL,
	"r2_key" text NOT NULL,
	"size_bytes" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_archive_entries" ADD CONSTRAINT "research_archive_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_archive_target_idx" ON "research_archive_entries" USING btree ("project_id","kind","target","fetched_at");--> statement-breakpoint
CREATE INDEX "research_archive_view_idx" ON "research_archive_entries" USING btree ("project_id","view_key","fetched_at");--> statement-breakpoint
CREATE INDEX "research_archive_project_fetched_idx" ON "research_archive_entries" USING btree ("project_id","fetched_at");--> statement-breakpoint
CREATE INDEX "research_archive_fetched_idx" ON "research_archive_entries" USING btree ("fetched_at");