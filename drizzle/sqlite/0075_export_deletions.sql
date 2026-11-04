CREATE TABLE `export_deletions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`table_name` text NOT NULL,
	`scope` text NOT NULL,
	`written_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `export_deletions_written_idx` ON `export_deletions` (`project_id`,`written_at`,`id`);