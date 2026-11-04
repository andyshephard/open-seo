import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The deployment's DataForSEO spend, against a monthly cap
// (server/lib/dataforseo/spend-cap.ts). Money is integer micro-USD
// (1 USD = 1_000_000) so sums never drift.

/**
 * One row per UTC month ("YYYY-MM"). `reserved_micros` is the estimate held for
 * calls in flight; a call is let through only if spent + reserved + its own
 * estimate stays within the cap, checked and reserved in one statement.
 */
export const dataforseoSpendMonths = sqliteTable("dataforseo_spend_months", {
  month: text("month").primaryKey(),
  spentMicros: integer("spent_micros").notNull().default(0),
  reservedMicros: integer("reserved_micros").notNull().default(0),
  liveCalls: integer("live_calls").notNull().default(0),
  refusedCalls: integer("refused_calls").notNull().default(0),
  // The cap in force when the month's last call was let through, so a past
  // month reports the cap that applied to it.
  capMicros: integer("cap_micros"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One row per paid DataForSEO request, written as "pending" before the cap is
 * checked. Refusals are counted on the month row; the ledger keeps only the
 * first refusal per caller per hour. Free requests (task_get collection,
 * appendix and locations reads) are not recorded unless the response reports
 * a cost.
 */
export const dataforseoSpendLedger = sqliteTable(
  "dataforseo_spend_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    month: text("month").notNull(),
    // Who made the call: "mcp:<tool> (<client>)", "app", "cron", "background".
    caller: text("caller").notNull(),
    path: text("path").notNull(),
    estimatedMicros: integer("estimated_micros").notNull(),
    costMicros: integer("cost_micros"),
    // "response" (DataForSEO's cost field), "estimate", or "none" (refused).
    costSource: text("cost_source"),
    // pending -> settled | failed | abandoned; refused rows never ran.
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    settledAt: text("settled_at"),
  },
  (table) => [
    index("dataforseo_spend_ledger_month_idx").on(table.month, table.caller),
    index("dataforseo_spend_ledger_status_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);
