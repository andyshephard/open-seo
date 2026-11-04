import { beforeEach, expect, it, vi } from "vitest";
import { ResearchHistoryRepository as repo } from "../repositories/ResearchHistoryRepository";
import {
  captureDomainOverview,
  captureKeywordMetrics,
} from "./researchHistoryCapture";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
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

const customer = {
  organizationId: "organization",
  userId: "user",
  userEmail: "user@example.com",
  projectId: "project",
};
const market = { locationCode: 2826, languageCode: "en" };
const overview = (organicTraffic: number, fetchedAt: string) => ({
  domain: "trivelalearning.com",
  ...market,
  organicTraffic,
  organicKeywords: 10,
  top3Keywords: 1,
  top10Keywords: 4,
  fetchedAt,
});

const metric = (searchVolume: number) => ({
  keyword: "times tables",
  searchVolume,
  cpc: 0.5,
  competition: 0.2,
  keywordDifficulty: 30,
});

beforeEach(async () => {
  await testDb.seedProject();
});

it("keeps one domain snapshot per fetch day and a new row on each later day", async () => {
  await captureDomainOverview(customer, overview(100, "2026-10-20T08:00:00Z"));
  await captureDomainOverview(customer, overview(150, "2026-10-21T08:00:00Z"));
  await captureDomainOverview(customer, overview(170, "2026-10-21T20:00:00Z"));

  const rows = await repo.listDomainSnapshots({
    projectId: "project",
    domains: ["trivelalearning.com"],
    ...market,
    since: "2026-01-01",
  });
  expect(rows.map((row) => [row.capturedOn, row.organicTraffic])).toEqual([
    ["2026-10-20", 100],
    ["2026-10-21", 170],
  ]);
});

it("records nothing for a lookup outside a verified project", async () => {
  await captureDomainOverview(
    { ...customer, projectId: undefined },
    overview(100, "2026-10-21T08:00:00Z"),
  );

  expect(await repo.listCapturedDomains("project")).toEqual([]);
});

it("upserts keyword snapshots per day", async () => {
  const at = new Date("2026-10-21T08:00:00Z");
  await captureKeywordMetrics(
    "project",
    { ...market, rows: [metric(1000)] },
    at,
  );
  await captureKeywordMetrics(
    "project",
    { ...market, rows: [metric(1200)] },
    at,
  );

  const rows = await repo.listKeywordSnapshots({
    projectId: "project",
    keywords: ["times tables"],
    ...market,
    since: "2026-01-01",
  });
  expect(rows.map((row) => row.searchVolume)).toEqual([1200]);
});
