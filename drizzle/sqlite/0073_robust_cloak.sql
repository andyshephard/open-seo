CREATE TABLE `report_sources` (
	`report_id` text NOT NULL,
	`archive_entry_id` text NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`archive_entry_id`) REFERENCES `research_archive_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_sources_pair` ON `report_sources` (`report_id`,`archive_entry_id`);