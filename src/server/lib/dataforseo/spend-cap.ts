import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch, runClaimed } from "@/db/runBatch";
import { dataforseoSpendLedger, dataforseoSpendMonths } from "@/db/schema";
import { AppError, asAppError } from "@/server/lib/errors";
import {
  costFromDataforseoResponse,
  formatUsd,
  getDataforseoMonthlyCapUsd,
  microsToUsd,
  MICROS_PER_USD,
  nextSpendMonthStart,
  spendMonth,
  usdToMicros,
} from "@/server/lib/dataforseo/spend-units";
import { currentDataforseoCaller } from "@/server/lib/dataforseo/spend-caller";
import { estimateDataforseoRequestUsd } from "@/server/lib/dataforseo/spend-estimates";

// A hard monthly cap on this deployment's DataForSEO spend, enforced at the
// one place every DataForSEO request leaves OpenSEO (core.ts). Cached results
// never reach that point, so they keep working at the cap.
//
// Per request: estimate its cost from the wire request (spend-estimates.ts),
// write a "pending" ledger row, then in ONE conditional upsert add the
// estimate to the month's reserved amount only if spent + reserved + estimate
// stays within the cap. That statement is the only gate, so two concurrent
// calls cannot both pass on the same headroom. After the call, the hold
// settles on the `cost` DataForSEO reports (or the estimate when the response
// has none or the call failed in a way that may still have been billed); the
// ledger row's close and the month update commit together.
//
// The ledger is the source of truth: the sweep (every 5 minutes) books holds
// whose call never settled (the worker died mid-call) at their estimate, and
// recomputes the month rows from the ledger, so any drift heals. The pending
// row is written before the reservation so a recompute can only ever count a
// hold early (refusing a little sooner), never miss one in flight.
//
// Money is integer micro-USD. Months are UTC calendar months, keyed "YYYY-MM";
// a call is booked to the month it was reserved in.

/** A pending hold this old belongs to a call that will never settle. */
export const ABANDONED_HOLD_MS = 60 * 60_000;

/** The ledger keeps one refusal per caller per this window; the month counts all. */
const REFUSAL_LOG_WINDOW_MS = 60 * 60_000;

// Failures that prove DataForSEO did not run (and so did not bill) the call.
const UNBILLED_ERROR_CODES = new Set([
  "DATAFORSEO_AUTH_FAILED",
  "AUTH_CONFIG_MISSING",
  "RATE_LIMITED",
]);

export class DataforseoSpendCapError extends AppError {
  constructor(input: {
    month: string;
    committedMicros: number;
    capMicros: number;
    estimateMicros: number;
  }) {
    const committed = microsToUsd(input.committedMicros);
    const cap = microsToUsd(input.capMicros);
    const estimate = microsToUsd(input.estimateMicros);
    super(
      "DATAFORSEO_SPEND_CAP_REACHED",
      `DataForSEO monthly cap reached ($${committed.toFixed(2)} of $${formatUsd(cap)}). ` +
        `This request needs about $${estimate.toFixed(3)}. Cached results still work; ` +
        `live DataForSEO calls resume on ${nextSpendMonthStart(input.month).slice(0, 10)} (UTC). ` +
        "Retrying will not help before then.",
      {
        provider: "dataforseo",
        month: input.month,
        spentUsd: committed.toFixed(6),
        capUsd: cap.toFixed(2),
        estimateUsd: estimate.toFixed(6),
      },
    );
    this.name = "DataforseoSpendCapError";
  }
}

type DataforseoSpendHold = {
  /** Settle on the cost in a parsed DataForSEO response (estimate if none). */
  settle(response: unknown): Promise<void>;
  /** Settle at the estimate (a response whose body is read elsewhere). */
  settleAtEstimate(): Promise<void>;
  /** The call threw: book 0 if it provably never ran, else the estimate. */
  fail(error: unknown): Promise<void>;
};

type SpendRequest = {
  method: "GET" | "POST";
  path: string;
  body: unknown;
  /** The sandbox host: free, and its costs are not real. */
  sandbox?: boolean;
};

function logSpendFailure(event: string, error: unknown, path: string) {
  console.error(event, {
    event,
    path,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Books a cost no hold was taken for (a request priced as free that billed). */
async function recordUnreservedCost(input: {
  month: string;
  caller: string;
  path: string;
  costMicros: number;
  at: string;
}) {
  await runBatch((tx) => [
    tx
      .insert(dataforseoSpendMonths)
      .values({
        month: input.month,
        spentMicros: input.costMicros,
        liveCalls: 1,
        updatedAt: input.at,
      })
      .onConflictDoUpdate({
        target: dataforseoSpendMonths.month,
        set: {
          spentMicros: sql`${dataforseoSpendMonths.spentMicros} + ${input.costMicros}`,
          liveCalls: sql`${dataforseoSpendMonths.liveCalls} + 1`,
          updatedAt: input.at,
        },
      }),
    tx.insert(dataforseoSpendLedger).values({
      month: input.month,
      caller: input.caller,
      path: input.path,
      estimatedMicros: 0,
      costMicros: input.costMicros,
      costSource: "response",
      status: "settled",
      createdAt: input.at,
      settledAt: input.at,
    }),
  ]);
}

/**
 * Refuse a call: count it on the month, and turn its pending ledger row into
 * a refusal only if its caller has none logged in the last hour (else drop
 * it), so a client retrying in a loop cannot grow the ledger. Always throws.
 */
async function refuse(input: {
  ledgerId: number;
  month: string;
  caller: string;
  path: string;
  estimateMicros: number;
  capMicros: number;
  at: Date;
}): Promise<never> {
  const at = input.at.toISOString();
  const logSince = new Date(
    input.at.getTime() - REFUSAL_LOG_WINDOW_MS,
  ).toISOString();
  const isThisHold = and(
    eq(dataforseoSpendLedger.id, input.ledgerId),
    eq(dataforseoSpendLedger.status, "pending"),
  );
  try {
    await runBatch((tx) => [
      tx
        .insert(dataforseoSpendMonths)
        .values({
          month: input.month,
          refusedCalls: 1,
          capMicros: input.capMicros,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: dataforseoSpendMonths.month,
          set: {
            refusedCalls: sql`${dataforseoSpendMonths.refusedCalls} + 1`,
            updatedAt: at,
          },
        }),
      tx
        .update(dataforseoSpendLedger)
        .set({
          status: "refused",
          costMicros: 0,
          costSource: "none",
          settledAt: at,
        })
        .where(
          and(
            isThisHold,
            sql`not exists (select 1 from dataforseo_spend_ledger as logged where logged.caller = ${input.caller} and logged.status = 'refused' and logged.created_at >= ${logSince})`,
          ),
        ),
      tx.delete(dataforseoSpendLedger).where(isThisHold),
    ]);
  } catch (error) {
    // Left pending, the row would be booked at its estimate by the sweep.
    logSpendFailure("dataforseo.spend-cap.refusal-failed", error, input.path);
    await db
      .delete(dataforseoSpendLedger)
      .where(isThisHold)
      .catch((deleteError: unknown) =>
        logSpendFailure(
          "dataforseo.spend-cap.release-failed",
          deleteError,
          input.path,
        ),
      );
  }
  console.warn("dataforseo.spend-cap.refused", {
    event: "dataforseo.spend-cap.refused",
    month: input.month,
    caller: input.caller,
    path: input.path,
  });
  const [row] = await db
    .select({
      spentMicros: dataforseoSpendMonths.spentMicros,
      reservedMicros: dataforseoSpendMonths.reservedMicros,
    })
    .from(dataforseoSpendMonths)
    .where(eq(dataforseoSpendMonths.month, input.month))
    .catch(() => []);
  throw new DataforseoSpendCapError({
    month: input.month,
    committedMicros: (row?.spentMicros ?? 0) + (row?.reservedMicros ?? 0),
    capMicros: input.capMicros,
    estimateMicros: input.estimateMicros,
  });
}

/**
 * Close a pending hold exactly once, and apply its cost to the month in the
 * same transaction (runClaimed). Whoever flips the ledger row from pending
 * (the call, or the sweep) is the one whose month update lands.
 */
export function closeHold(input: {
  ledgerId: number;
  month: string;
  estimateMicros: number;
  costMicros: number;
  costSource: "response" | "estimate" | "none";
  status: "settled" | "failed" | "abandoned";
  at: string;
}): Promise<boolean> {
  const apply = (tx: typeof db, whilePending: boolean) =>
    tx
      .update(dataforseoSpendMonths)
      .set({
        spentMicros: sql`${dataforseoSpendMonths.spentMicros} + ${input.costMicros}`,
        reservedMicros: sql`CASE WHEN ${dataforseoSpendMonths.reservedMicros} >= ${input.estimateMicros} THEN ${dataforseoSpendMonths.reservedMicros} - ${input.estimateMicros} ELSE 0 END`,
        liveCalls: sql`${dataforseoSpendMonths.liveCalls} + 1`,
        updatedAt: input.at,
      })
      .where(
        whilePending
          ? and(
              eq(dataforseoSpendMonths.month, input.month),
              sql`exists (select 1 from dataforseo_spend_ledger as hold where hold.id = ${input.ledgerId} and hold.status = 'pending')`,
            )
          : eq(dataforseoSpendMonths.month, input.month),
      );
  return runClaimed({
    claim: (tx) =>
      tx
        .update(dataforseoSpendLedger)
        .set({
          status: input.status,
          costMicros: input.costMicros,
          costSource: input.costSource,
          settledAt: input.at,
        })
        .where(
          and(
            eq(dataforseoSpendLedger.id, input.ledgerId),
            eq(dataforseoSpendLedger.status, "pending"),
          ),
        )
        .returning({ id: dataforseoSpendLedger.id }),
    apply: (tx) => apply(tx, false),
    applyWhileUnclaimed: (tx) => apply(tx, true),
  });
}

const NOOP_SETTLE = async () => {};

/**
 * Hold a request's estimated cost against this month's cap, or throw
 * DataforseoSpendCapError (DATAFORSEO_SPEND_CAP_REACHED) without calling
 * DataForSEO. Free requests take no hold and touch no table unless their
 * response reports a cost.
 */
export async function holdDataforseoSpend(
  request: SpendRequest,
  now: () => Date = () => new Date(),
): Promise<DataforseoSpendHold> {
  const caller = currentDataforseoCaller();
  const path = request.path.split("?")[0];
  const estimateMicros = Math.ceil(
    estimateDataforseoRequestUsd(request) * MICROS_PER_USD,
  );

  if (estimateMicros === 0) {
    if (request.sandbox)
      return {
        settle: NOOP_SETTLE,
        settleAtEstimate: NOOP_SETTLE,
        fail: NOOP_SETTLE,
      };
    return {
      settle: async (response) => {
        const cost = costFromDataforseoResponse(response);
        if (!cost) return;
        const at = now();
        try {
          await recordUnreservedCost({
            month: spendMonth(at),
            caller,
            path,
            costMicros: usdToMicros(cost),
            at: at.toISOString(),
          });
        } catch (error) {
          logSpendFailure("dataforseo.spend-cap.settle-failed", error, path);
        }
      },
      settleAtEstimate: NOOP_SETTLE,
      fail: NOOP_SETTLE,
    };
  }

  const reservedAt = now();
  const month = spendMonth(reservedAt);
  const at = reservedAt.toISOString();
  const capMicros = usdToMicros(await getDataforseoMonthlyCapUsd());

  // The pending row first: from here on the sweep's recompute counts this
  // hold, whether or not the reservation below has landed yet.
  const [pending] = await db
    .insert(dataforseoSpendLedger)
    .values({
      month,
      caller,
      path,
      estimatedMicros: estimateMicros,
      status: "pending",
      createdAt: at,
    })
    .returning({ id: dataforseoSpendLedger.id });
  const ledgerId = pending.id;
  const refusal = {
    ledgerId,
    month,
    caller,
    path,
    estimateMicros,
    capMicros,
    at: reservedAt,
  };

  if (estimateMicros > capMicros) return refuse(refusal);

  // The gate. On a new month the row is created holding this estimate (which
  // fits the cap, checked above); otherwise the update applies only while the
  // estimate fits, and returns no row when it does not.
  let reserved: unknown[];
  try {
    reserved = await db
      .insert(dataforseoSpendMonths)
      .values({
        month,
        reservedMicros: estimateMicros,
        capMicros,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: dataforseoSpendMonths.month,
        set: {
          reservedMicros: sql`${dataforseoSpendMonths.reservedMicros} + ${estimateMicros}`,
          capMicros,
          updatedAt: at,
        },
        setWhere: sql`${dataforseoSpendMonths.spentMicros} + ${dataforseoSpendMonths.reservedMicros} + ${estimateMicros} <= ${capMicros}`,
      })
      .returning({ month: dataforseoSpendMonths.month });
  } catch (error) {
    // The reservation did not land: drop the pending row. If even that fails,
    // the sweep books the row at its estimate (errs toward refusing).
    await db
      .delete(dataforseoSpendLedger)
      .where(
        and(
          eq(dataforseoSpendLedger.id, ledgerId),
          eq(dataforseoSpendLedger.status, "pending"),
        ),
      )
      .catch((deleteError: unknown) =>
        logSpendFailure(
          "dataforseo.spend-cap.release-failed",
          deleteError,
          path,
        ),
      );
    throw error;
  }
  if (reserved.length === 0) return refuse(refusal);

  const close = async (
    costMicros: number,
    costSource: "response" | "estimate" | "none",
    status: "settled" | "failed",
  ) => {
    try {
      await closeHold({
        ledgerId,
        month,
        estimateMicros,
        costMicros,
        costSource,
        status,
        at: now().toISOString(),
      });
    } catch (error) {
      // The hold stays pending (it errs toward refusing) until the sweep.
      logSpendFailure("dataforseo.spend-cap.settle-failed", error, path);
    }
  };

  return {
    settle: async (response) => {
      const cost = costFromDataforseoResponse(response);
      if (cost === null) await close(estimateMicros, "estimate", "settled");
      else await close(usdToMicros(cost), "response", "settled");
    },
    settleAtEstimate: () => close(estimateMicros, "estimate", "settled"),
    fail: async (error) => {
      const code = asAppError(error)?.code;
      if (code && UNBILLED_ERROR_CODES.has(code))
        await close(0, "none", "failed");
      else await close(estimateMicros, "estimate", "failed");
    },
  };
}
