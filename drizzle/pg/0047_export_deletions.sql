CREATE TABLE "export_deletions" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"table_name" text NOT NULL,
	"scope" text NOT NULL,
	"written_at" text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "export_deletions" ADD CONSTRAINT "export_deletions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_deletions_written_idx" ON "export_deletions" USING btree ("project_id","written_at","id");