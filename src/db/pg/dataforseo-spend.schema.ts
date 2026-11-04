import { index, integer, pgTable, serial, text } from "drizzle-orm/pg-core";

// Postgres twin of ../dataforseo-spend.schema.ts (see schema-parity.test.ts).

export const dataforseoSpendMonths = pgTable("dataforseo_spend_months", {
  month: text("month").primaryKey(),
  spentMicros: integer("spent_micros").notNull().default(0),
  reservedMicros: integer("reserved_micros").notNull().default(0),
  liveCalls: integer("live_calls").notNull().default(0),
  refusedCalls: integer("refused_calls").notNull().default(0),
  capMicros: integer("cap_micros"),
  updatedAt: text("updated_at").notNull(),
});

export const dataforseoSpendLedger = pgTable(
  "dataforseo_spend_ledger",
  {
    id: serial("id").primaryKey(),
    month: text("month").notNull(),
    caller: text("caller").notNull(),
    path: text("path").notNull(),
    estimatedMicros: integer("estimated_micros").notNull(),
    costMicros: integer("cost_micros"),
    costSource: text("cost_source"),
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
