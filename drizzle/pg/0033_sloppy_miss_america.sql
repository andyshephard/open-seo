CREATE TABLE "domain_backlink_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"domain" text NOT NULL,
	"include_subdomains" boolean NOT NULL,
	"captured_on" text NOT NULL,
	"rank" integer,
	"backlinks" bigint,
	"referring_domains" bigint,
	"referring_pages" bigint,
	"broken_backlinks" bigint,
	"new_backlinks" bigint,
	"lost_backlinks" bigint,
	"new_referring_domains" bigint,
	"lost_referring_domains" bigint,
	"spam_score" integer,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"domain" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"captured_on" text NOT NULL,
	"organic_traffic" bigint,
	"organic_keywords" bigint,
	"top3_keywords" bigint,
	"top10_keywords" bigint,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keyword_metric_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"keyword" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"captured_on" text NOT NULL,
	"search_volume" integer,
	"cpc" real,
	"competition" real,
	"keyword_difficulty" integer,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_snapshot_schedules" (
	"project_id" text PRIMARY KEY NOT NULL,
	"interval" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"include_keywords" boolean DEFAULT true NOT NULL,
	"next_check_at" text NOT NULL,
	"last_checked_at" text,
	"last_skip_reason" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_backlink_snapshots" ADD CONSTRAINT "domain_backlink_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_snapshots" ADD CONSTRAINT "domain_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_metric_snapshots" ADD CONSTRAINT "keyword_metric_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_snapshot_schedules" ADD CONSTRAINT "research_snapshot_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_backlink_snapshots_unique_day" ON "domain_backlink_snapshots" USING btree ("project_id","domain","include_subdomains","captured_on");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_snapshots_unique_day" ON "domain_snapshots" USING btree ("project_id","domain","location_code","language_code","captured_on");--> statement-breakpoint
CREATE UNIQUE INDEX "keyword_metric_snapshots_unique_day" ON "keyword_metric_snapshots" USING btree ("project_id","keyword","location_code","language_code","captured_on");--> statement-breakpoint
CREATE INDEX "research_snapshot_schedules_due_idx" ON "research_snapshot_schedules" USING btree ("next_check_at");