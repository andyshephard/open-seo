CREATE TABLE `dataforseo_spend_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`caller` text NOT NULL,
	`path` text NOT NULL,
	`estimated_micros` integer NOT NULL,
	`cost_micros` integer,
	`cost_source` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`settled_at` text
);
--> statement-breakpoint
CREATE INDEX `dataforseo_spend_ledger_month_idx` ON `dataforseo_spend_ledger` (`month`,`caller`);--> statement-breakpoint
CREATE INDEX `dataforseo_spend_ledger_status_idx` ON `dataforseo_spend_ledger` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `dataforseo_spend_months` (
	`month` text PRIMARY KEY NOT NULL,
	`spent_micros` integer DEFAULT 0 NOT NULL,
	`reserved_micros` integer DEFAULT 0 NOT NULL,
	`live_calls` integer DEFAULT 0 NOT NULL,
	`refused_calls` integer DEFAULT 0 NOT NULL,
	`cap_micros` integer,
	`updated_at` text NOT NULL
);
