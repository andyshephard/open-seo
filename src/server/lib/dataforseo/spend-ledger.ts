import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { sort } from "remeda";
import { db } from "@/db";
import { dataforseoSpendLedger, dataforseoSpendMonths } from "@/db/schema";
import {
  ABANDONED_HOLD_MS,
  closeHold,
} from "@/server/lib/dataforseo/spend-cap";
import {
  getDataforseoMonthlyCapUsd,
  microsToUsd,
  nextSpendMonthStart,
  spendMonth,
  usdToMicros,
} from "@/server/lib/dataforseo/spend-units";

// Reading and upkeep of the DataForSEO spend ledger the monthly cap keeps
// (spend-cap.ts).

/** Ledger rows are kept this many months back (plus the current one). */
const LEDGER_RETENTION_MONTHS = 13;

function monthsBefore(month: string, count: number): string {
  const [year, monthIndex] = month.split("-").map(Number);
  return spendMonth(new Date(Date.UTC(year, monthIndex - 1 - count, 1)));
}

/** The month before a "YYYY-MM" month. */
function previousMonth(month: string): string {
  return monthsBefore(month, 1);
}

/**
 * Rebuild month rows from the ledger, the source of truth: reserved is the
 * estimates still pending, spent and live calls are the closed calls.
 * Refusals are not in the ledger in full, so their count is kept. One
 * statement, so it reads a consistent ledger.
 */
async function recomputeMonths(months: string[]) {
  const closed = sql`('settled', 'failed', 'abandoned')`;
  await db
    .update(dataforseoSpendMonths)
    .set({
      reservedMicros: sql`(select coalesce(sum(l.estimated_micros), 0) from dataforseo_spend_ledger as l where l.month = dataforseo_spend_months.month and l.status = 'pending')`,
      spentMicros: sql`(select coalesce(sum(l.cost_micros), 0) from dataforseo_spend_ledger as l where l.month = dataforseo_spend_months.month and l.status in ${closed})`,
      liveCalls: sql`(select count(*) from dataforseo_spend_ledger as l where l.month = dataforseo_spend_months.month and l.status in ${closed})`,
    })
    .where(inArray(dataforseoSpendMonths.month, months));
}

/**
 * Upkeep, every 5 minutes: book holds whose call never settled at their
 * estimate, then recompute this month's and last month's rows from the
 * ledger so any drift (a failed settle, a crash between steps) heals.
 */
export async function sweepDataforseoSpend(now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - ABANDONED_HOLD_MS).toISOString();
  const stale = await db
    .select({
      id: dataforseoSpendLedger.id,
      month: dataforseoSpendLedger.month,
      estimatedMicros: dataforseoSpendLedger.estimatedMicros,
    })
    .from(dataforseoSpendLedger)
    .where(
      and(
        eq(dataforseoSpendLedger.status, "pending"),
        lt(dataforseoSpendLedger.createdAt, cutoff),
      ),
    );
  let abandoned = 0;
  for (const hold of stale) {
    const closed = await closeHold({
      ledgerId: hold.id,
      month: hold.month,
      estimateMicros: hold.estimatedMicros,
      costMicros: hold.estimatedMicros,
      costSource: "estimate",
      status: "abandoned",
      at: now.toISOString(),
    });
    if (closed) abandoned++;
  }
  const month = spendMonth(now);
  await recomputeMonths([month, previousMonth(month)]);
  return { abandoned };
}

/** Daily: drop ledger rows past retention (the month totals are kept). */
export async function pruneDataforseoSpendLedger(now: Date = new Date()) {
  const oldest = monthsBefore(spendMonth(now), LEDGER_RETENTION_MONTHS);
  await db
    .delete(dataforseoSpendLedger)
    .where(lt(dataforseoSpendLedger.month, oldest));
}

type DataforseoSpendSummary = {
  month: string;
  capUsd: number;
  spentUsd: number;
  /** Held for calls in flight. */
  reservedUsd: number;
  remainingUsd: number;
  capReached: boolean;
  resetsAt: string;
  liveCalls: number;
  refusedCalls: number;
  callers: Array<{
    caller: string;
    liveCalls: number;
    /** Logged refusals: at most one per caller per hour (the month counts all). */
    refusalsLogged: number;
    pendingCalls: number;
    spentUsd: number;
  }>;
};

/**
 * A month's spend against its cap, with per-caller totals. The current month
 * reports the configured cap; a past month the cap in force when its last
 * call was let through.
 */
export async function readDataforseoSpend(
  month: string = spendMonth(new Date()),
  now: Date = new Date(),
): Promise<DataforseoSpendSummary> {
  const [totals] = await db
    .select()
    .from(dataforseoSpendMonths)
    .where(eq(dataforseoSpendMonths.month, month));
  const capMicros =
    month !== spendMonth(now) && totals?.capMicros != null
      ? totals.capMicros
      : usdToMicros(await getDataforseoMonthlyCapUsd());
  const callers = await db
    .select({
      caller: dataforseoSpendLedger.caller,
      liveCalls: sql<number>`sum(case when ${dataforseoSpendLedger.status} in ('settled', 'failed', 'abandoned') then 1 else 0 end)`,
      refusalsLogged: sql<number>`sum(case when ${dataforseoSpendLedger.status} = 'refused' then 1 else 0 end)`,
      pendingCalls: sql<number>`sum(case when ${dataforseoSpendLedger.status} = 'pending' then 1 else 0 end)`,
      spentMicros: sql<number>`coalesce(sum(${dataforseoSpendLedger.costMicros}), 0)`,
    })
    .from(dataforseoSpendLedger)
    .where(eq(dataforseoSpendLedger.month, month))
    .groupBy(dataforseoSpendLedger.caller);
  const spentMicros = totals?.spentMicros ?? 0;
  const reservedMicros = totals?.reservedMicros ?? 0;
  const remainingMicros = Math.max(0, capMicros - spentMicros - reservedMicros);
  return {
    month,
    capUsd: microsToUsd(capMicros),
    spentUsd: microsToUsd(spentMicros),
    reservedUsd: microsToUsd(reservedMicros),
    remainingUsd: microsToUsd(remainingMicros),
    capReached: remainingMicros === 0,
    resetsAt: nextSpendMonthStart(month),
    liveCalls: totals?.liveCalls ?? 0,
    refusedCalls: totals?.refusedCalls ?? 0,
    callers: sort(
      callers.map((row) => ({
        caller: row.caller,
        liveCalls: Number(row.liveCalls),
        refusalsLogged: Number(row.refusalsLogged),
        pendingCalls: Number(row.pendingCalls),
        spentUsd: microsToUsd(Number(row.spentMicros)),
      })),
      (a, b) => b.spentUsd - a.spentUsd || a.caller.localeCompare(b.caller),
    ),
  };
}
