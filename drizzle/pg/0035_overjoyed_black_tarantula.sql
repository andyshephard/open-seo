CREATE TABLE "gsc_daily_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"date" text NOT NULL,
	"dimension" text NOT NULL,
	"value" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" bigint NOT NULL,
	"ctr" real NOT NULL,
	"position" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_daily_totals" (
	"project_id" text NOT NULL,
	"date" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" bigint NOT NULL,
	"ctr" real NOT NULL,
	"position" real NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gsc_daily_rows" ADD CONSTRAINT "gsc_daily_rows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_daily_totals" ADD CONSTRAINT "gsc_daily_totals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_daily_rows_day" ON "gsc_daily_rows" USING btree ("project_id","dimension","value","date");--> statement-breakpoint
CREATE INDEX "gsc_daily_rows_project_date_idx" ON "gsc_daily_rows" USING btree ("project_id","dimension","date");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_daily_totals_day" ON "gsc_daily_totals" USING btree ("project_id","date");