import { getOptionalEnvValue } from "@/server/lib/runtime-env";

// Units of the DataForSEO spend cap (spend-cap.ts): micro-USD money, UTC
// months, the configured cap, and the cost a response reports.

const DEFAULT_DATAFORSEO_MONTHLY_CAP_USD = 25;
const DATAFORSEO_CAP_ENV = "DATAFORSEO_MONTHLY_CAP_USD";
export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: number): number {
  return Math.round(micros) / MICROS_PER_USD;
}

export function spendMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** First instant of the next UTC month, when the cap resets. */
export function nextSpendMonthStart(month: string): string {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex, 1)).toISOString();
}

/**
 * The cap in USD, from DATAFORSEO_MONTHLY_CAP_USD (an operator setting, not a
 * user one), else 25. A value that is not a finite number >= 0 falls back to
 * the default rather than lifting the cap.
 */
export async function getDataforseoMonthlyCapUsd(): Promise<number> {
  const raw = await getOptionalEnvValue(DATAFORSEO_CAP_ENV);
  if (raw === undefined) return DEFAULT_DATAFORSEO_MONTHLY_CAP_USD;
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0) {
    console.warn("dataforseo.spend-cap.invalid-config", {
      event: "dataforseo.spend-cap.invalid-config",
      fallbackUsd: DEFAULT_DATAFORSEO_MONTHLY_CAP_USD,
    });
    return DEFAULT_DATAFORSEO_MONTHLY_CAP_USD;
  }
  return value;
}

export function formatUsd(usd: number): string {
  return Number.isInteger(usd) ? String(usd) : usd.toFixed(2);
}

/**
 * The cost DataForSEO reports for a response: the envelope's `cost`, else the
 * sum of its tasks' `cost`. Null when the response carries neither.
 */
export function costFromDataforseoResponse(response: unknown): number | null {
  if (typeof response !== "object" || response === null) return null;
  const cost: unknown = Reflect.get(response, "cost");
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
    return cost;
  const tasks: unknown = Reflect.get(response, "tasks");
  if (!Array.isArray(tasks)) return null;
  let sum = 0;
  let found = false;
  for (const task of tasks) {
    const taskCost: unknown =
      typeof task === "object" && task !== null
        ? Reflect.get(task, "cost")
        : undefined;
    if (typeof taskCost === "number" && Number.isFinite(taskCost)) {
      sum += taskCost;
      found = true;
    }
  }
  return found ? sum : null;
}
