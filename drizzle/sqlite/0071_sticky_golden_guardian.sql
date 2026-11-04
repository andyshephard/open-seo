CREATE TABLE `gsc_daily_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`dimension` text NOT NULL,
	`value` text NOT NULL,
	`clicks` integer NOT NULL,
	`impressions` integer NOT NULL,
	`ctr` real NOT NULL,
	`position` real NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gsc_daily_rows_day` ON `gsc_daily_rows` (`project_id`,`dimension`,`value`,`date`);--> statement-breakpoint
CREATE INDEX `gsc_daily_rows_project_date_idx` ON `gsc_daily_rows` (`project_id`,`dimension`,`date`);--> statement-breakpoint
CREATE TABLE `gsc_daily_totals` (
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`clicks` integer NOT NULL,
	`impressions` integer NOT NULL,
	`ctr` real NOT NULL,
	`position` real NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gsc_daily_totals_day` ON `gsc_daily_totals` (`project_id`,`date`);