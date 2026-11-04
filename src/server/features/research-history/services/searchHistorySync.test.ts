import { beforeEach, expect, it, vi } from "vitest";
import {
  exportDeletions,
  gscDailyRows,
  gscDailyTotals,
  researchArchiveEntries,
} from "@/db/schema";
import type { GscSearchAnalyticsRequest } from "@/server/lib/gscClient";
import { deleteSearchConsoleCopies } from "./googleDataErasure";
import { getSearchConsoleHistory } from "./searchConsoleHistory";
import { runDailySearchHistorySync } from "./searchHistorySync";

const { testDb, querySearchAnalytics, runReport } = await vi.hoisted(
  async () => {
    const { createAiVisibilityTestDb } =
      await import("@/server/features/ai-visibility/aiVisibilityTestDb");
    return {
      testDb: await createAiVisibilityTestDb(),
      querySearchAnalytics: vi.fn(),
      runReport: vi.fn(),
    };
  },
);
vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: "d1",
    R2: { put: async () => undefined, delete: async () => undefined },
  },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/server/features/ga4/services/Ga4ReportingService", () => ({
  Ga4ReportingService: { runReport },
}));
vi.mock("@/db/runBatch", () => ({
  runBatch: testDb.runBatch,
  executeInBatches: async <T>(
    items: T[],
    build: (tx: typeof testDb.db, item: T) => Promise<unknown>,
  ) => {
    for (const item of items) await build(testDb.db, item);
  },
}));
vi.mock("@/server/lib/gscClient", () => ({
  createGscClient: () => ({ querySearchAnalytics }),
}));

// One row per requested day: totals by date, or one query/page per day.
function rowsFor(request: GscSearchAnalyticsRequest) {
  const dimension = request.dimensions?.[0];
  if (dimension === "date") {
    const rows = [];
    for (
      let day = new Date(`${request.startDate}T00:00:00Z`);
      day.toISOString().slice(0, 10) <= request.endDate;
      day.setUTCDate(day.getUTCDate() + 1)
    )
      rows.push({
        keys: [day.toISOString().slice(0, 10)],
        clicks: 10,
        impressions: 100,
        ctr: 0.1,
        position: 8,
      });
    return rows;
  }
  return [
    {
      keys: [dimension === "query" ? "times tables" : "https://x.test/"],
      clicks: 5,
      impressions: 50,
      ctr: 0.1,
      position: 4,
    },
  ];
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T03:17:00Z"));
  querySearchAnalytics.mockImplementation(
    async (_site: string, request: GscSearchAnalyticsRequest) =>
      rowsFor(request),
  );
  await testDb.seedProject();
  await testDb.client.execute(
    `INSERT INTO gsc_connections (id, project_id, organization_id, site_url, connected_by_user_id)
     VALUES ('gsc', 'project', 'organization', 'sc-domain:x.test', 'user')`,
  );
});

it("backfills once, then syncs only the days after the last stored one", async () => {
  await runDailySearchHistorySync();
  const firstRunCalls = querySearchAnalytics.mock.calls.length;
  vi.setSystemTime(new Date("2026-10-22T03:17:00Z"));
  await runDailySearchHistorySync();

  // Day two adds one totals request and one query + one page request.
  expect(querySearchAnalytics.mock.calls.length - firstRunCalls).toBe(3);
  const history = await getSearchConsoleHistory({
    projectId: "project",
    days: 30,
    dimension: "query",
    limit: 10,
  });
  expect(history.to).toBe("2026-10-19");
  expect(history.totals).toHaveLength(30);
  expect(history.rows).toEqual([
    expect.objectContaining({ value: "times tables", clicks: 5 * 30 }),
  ]);
});

/** Runs `change` (SQL) during the first query-rows request of the sync. */
function duringFirstRowsRequest(change: string) {
  let changed = false;
  querySearchAnalytics.mockImplementation(
    async (_site: string, request: GscSearchAnalyticsRequest) => {
      if (request.dimensions?.[0] === "query" && !changed) {
        changed = true;
        await testDb.client.execute(change);
      }
      return rowsFor(request);
    },
  );
}

it("writes nothing after Search Console is disconnected mid-sync", async () => {
  duringFirstRowsRequest("DELETE FROM gsc_connections");

  await runDailySearchHistorySync();

  // Totals were written before the disconnect; the rows fetched after it,
  // and every later day, are not.
  expect(await testDb.db.select().from(gscDailyRows)).toEqual([]);
  expect(querySearchAnalytics).toHaveBeenCalledTimes(2);
});

it("stops writing the old property once the project switches mid-sync", async () => {
  duringFirstRowsRequest(
    "UPDATE gsc_connections SET site_url = 'sc-domain:y.test'",
  );

  await runDailySearchHistorySync();

  expect(await testDb.db.select().from(gscDailyRows)).toEqual([]);
});

it("backfills a switched property in full once the old copies are deleted", async () => {
  await runDailySearchHistorySync();
  await deleteSearchConsoleCopies("project");
  await testDb.client.execute(
    "UPDATE gsc_connections SET site_url = 'sc-domain:y.test'",
  );
  querySearchAnalytics.mockClear();

  await runDailySearchHistorySync();

  expect(querySearchAnalytics).toHaveBeenCalledWith(
    "sc-domain:y.test",
    expect.objectContaining({ dimensions: ["date"], startDate: "2025-06-20" }),
  );
  expect(
    (await testDb.db.select().from(exportDeletions)).map(
      (row) => row.tableName,
    ),
  ).toEqual(["gsc_daily_totals", "gsc_daily_rows"]);
  expect(await testDb.db.select().from(gscDailyTotals)).toHaveLength(486);
});

it("writes no GA4 report after GA4 is disconnected mid-sync", async () => {
  await testDb.client.execute(
    `INSERT INTO ga4_connections (id, project_id, organization_id, property_id, property_display_name, property_time_zone, property_currency_code, connected_by_user_id, ga4_account_id)
     VALUES ('ga4', 'project', 'organization', 'properties/1', 'X', 'UTC', 'USD', 'user', 'google-a')`,
  );
  runReport
    .mockResolvedValueOnce({ rows: [] })
    .mockImplementationOnce(async () => {
      await testDb.client.execute("DELETE FROM ga4_connections");
      return { rows: [] };
    });

  await runDailySearchHistorySync();

  expect(runReport).toHaveBeenCalledTimes(2);
  expect(await testDb.db.select().from(researchArchiveEntries)).toHaveLength(1);
});
