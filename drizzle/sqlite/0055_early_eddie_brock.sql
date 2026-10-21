CREATE TABLE `domain_backlink_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`domain` text NOT NULL,
	`include_subdomains` integer NOT NULL,
	`captured_on` text NOT NULL,
	`rank` integer,
	`backlinks` integer,
	`referring_domains` integer,
	`referring_pages` integer,
	`broken_backlinks` integer,
	`new_backlinks` integer,
	`lost_backlinks` integer,
	`new_referring_domains` integer,
	`lost_referring_domains` integer,
	`spam_score` integer,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_backlink_snapshots_unique_day` ON `domain_backlink_snapshots` (`project_id`,`domain`,`include_subdomains`,`captured_on`);--> statement-breakpoint
CREATE TABLE `domain_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`domain` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`captured_on` text NOT NULL,
	`organic_traffic` integer,
	`organic_keywords` integer,
	`top3_keywords` integer,
	`top10_keywords` integer,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_snapshots_unique_day` ON `domain_snapshots` (`project_id`,`domain`,`location_code`,`language_code`,`captured_on`);--> statement-breakpoint
CREATE TABLE `keyword_metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`keyword` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`captured_on` text NOT NULL,
	`search_volume` integer,
	`cpc` real,
	`competition` real,
	`keyword_difficulty` integer,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keyword_metric_snapshots_unique_day` ON `keyword_metric_snapshots` (`project_id`,`keyword`,`location_code`,`language_code`,`captured_on`);--> statement-breakpoint
CREATE TABLE `research_snapshot_schedules` (
	`project_id` text PRIMARY KEY NOT NULL,
	`interval` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`include_keywords` integer DEFAULT true NOT NULL,
	`next_check_at` text NOT NULL,
	`last_checked_at` text,
	`last_skip_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_snapshot_schedules_due_idx` ON `research_snapshot_schedules` (`next_check_at`);