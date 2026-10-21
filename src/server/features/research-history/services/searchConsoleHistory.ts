import { SearchHistoryRepository as repo } from "../repositories/SearchHistoryRepository";

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Stored Search Console history for a project: daily site totals and the top
 * queries or pages over the range, each compared with the period before it.
 * Reads only OpenSEO's daily copy; never calls Google.
 */
export async function getSearchConsoleHistory(input: {
  projectId: string;
  days: number;
  dimension: "query" | "page";
  limit: number;
  /** Narrow to one query or page. */
  value?: string;
}) {
  const latest = await repo.latestTotalsDate(input.projectId);
  if (!latest)
    return { from: null, to: null, totals: [], rows: [], synced: false };
  const to = latest;
  const from = addDays(to, -(input.days - 1));
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(input.days - 1));
  const [totals, current, previous] = await Promise.all([
    repo.listTotals(input.projectId, from, to),
    repo.topRows({ ...input, from, to }),
    repo.topRows({
      ...input,
      from: previousFrom,
      to: previousTo,
      limit: input.limit * 4,
    }),
  ]);
  const before = new Map(previous.map((row) => [row.value, row]));
  return {
    from,
    to,
    synced: true,
    totals: totals.map(({ projectId: _projectId, ...day }) => day),
    rows: current.map((row) => ({
      ...row,
      previousClicks: before.get(row.value)?.clicks ?? null,
      previousPosition: before.get(row.value)?.position ?? null,
    })),
  };
}
