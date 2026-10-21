import { beforeEach, expect, it, vi } from "vitest";
import type { GscSearchAnalyticsRequest } from "@/server/lib/gscClient";
import { getSearchConsoleHistory } from "./searchConsoleHistory";
import { runDailySearchHistorySync } from "./searchHistorySync";

const { testDb, querySearchAnalytics } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    querySearchAnalytics: vi.fn(),
  };
});
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
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
