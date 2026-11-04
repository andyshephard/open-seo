import { beforeEach, expect, it, vi } from "vitest";
import { ResearchHistoryRepository as repo } from "../repositories/ResearchHistoryRepository";
import { runScheduledResearchSnapshots } from "./researchSnapshots";

const { testDb, getOverview, profileOverview } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    getOverview: vi.fn(),
    profileOverview: vi.fn(),
  };
});
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/server/features/domain/services/DomainService", () => ({
  DomainService: {
    getOverview,
    getKeywordsPage: vi.fn(),
    getPagesPage: vi.fn(),
  },
}));
vi.mock("@/server/features/backlinks/services/BacklinksService", () => ({
  BacklinksService: {
    profileOverview,
    profileBacklinksPage: vi.fn(),
    profileReferringDomainsPage: vi.fn(),
    profileTopPagesPage: vi.fn(),
  },
}));
vi.mock("@/server/features/keywords/services/KeywordResearchService", () => ({
  KeywordResearchService: { refreshSavedKeywordMetrics: vi.fn() },
}));

const due = "2026-10-01T06:00:00.000Z";

beforeEach(async () => {
  await testDb.seedProject();
  await testDb.client.execute(
    "INSERT INTO project_competitors (id, project_id, domain, updated_by) VALUES ('c1', 'project', 'rival.com', 'user')",
  );
  await repo.upsertSchedule({
    projectId: "project",
    interval: "weekly",
    includeKeywords: false,
    locationCode: 2826,
    languageCode: "en",
    nextCheckAt: due,
  });
});

it("captures a due project once per tick and advances its schedule", async () => {
  await runScheduledResearchSnapshots();
  await runScheduledResearchSnapshots();

  expect(getOverview).toHaveBeenCalledTimes(2);
  expect(getOverview).toHaveBeenCalledWith(
    expect.objectContaining({ domain: "rival.com", maxAgeDays: 1 }),
    expect.objectContaining({ projectId: "project" }),
  );
  expect(profileOverview).toHaveBeenCalledTimes(2);
  const schedule = await repo.getSchedule("project");
  expect(schedule?.nextCheckAt > new Date().toISOString()).toBe(true);
  expect(schedule?.lastSkipReason).toBeNull();
});
