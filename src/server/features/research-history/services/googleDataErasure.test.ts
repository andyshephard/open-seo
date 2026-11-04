import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  domainSnapshots,
  exportDeletions,
  gscDailyRows,
  gscDailyTotals,
  keywordMetricSnapshots,
  researchArchiveEntries,
} from "@/db/schema";
import type { ResearchArchiveKind } from "@/types/schemas/researchHistory";
import { ResearchHistoryRepository } from "../repositories/ResearchHistoryRepository";
import {
  deleteGa4Copies,
  deleteSearchConsoleCopies,
} from "./googleDataErasure";
import { pruneResearchArchive } from "./researchArchive";

const { testDb, objects } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    objects: new Map<string, string>(),
  };
});
vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: "d1",
    R2: {
      delete: async (keys: string[]) => {
        for (const key of keys) objects.delete(key);
      },
    },
  },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));

const project = "project";
const gscDay = (date: string) => ({
  projectId: project,
  date,
  clicks: 1,
  impressions: 10,
  ctr: 0.1,
  position: 4,
});

async function archived(
  id: string,
  kind: ResearchArchiveKind,
  fetchedAt = "2026-10-01T00:00:00.000Z",
  projectId = project,
) {
  const r2Key = `research-archive/${projectId}/${id}.json`;
  objects.set(r2Key, "{}");
  await testDb.db.insert(researchArchiveEntries).values({
    id,
    projectId,
    kind,
    target: "openseo.so",
    viewKey: `view:${id}`,
    params: "{}",
    origin: "app",
    fetchedAt,
    r2Key,
    sizeBytes: 2,
  });
}

async function deletions() {
  const rows = await testDb.db
    .select()
    .from(exportDeletions)
    .orderBy(exportDeletions.id);
  return rows.map((row) => ({
    projectId: row.projectId,
    tableName: row.tableName,
    scope: JSON.parse(row.scope) as unknown,
  }));
}

async function archiveIds() {
  const rows = await testDb.db
    .select({ id: researchArchiveEntries.id })
    .from(researchArchiveEntries)
    .orderBy(researchArchiveEntries.id);
  return rows.map((row) => row.id);
}

beforeEach(async () => {
  objects.clear();
  await testDb.seedProject();
  await testDb.client.executeMultiple(`
    INSERT INTO projects (id, organization_id, name, domain)
      VALUES ('other-project', 'organization', 'Other', 'other.example');
  `);
});

describe("Search Console disconnect", () => {
  it("deletes the project's history and URL inspections and records each delete", async () => {
    await testDb.db.insert(gscDailyTotals).values(gscDay("2026-10-01"));
    await testDb.db.insert(gscDailyRows).values({
      ...gscDay("2026-10-01"),
      dimension: "query",
      value: "open seo",
    });
    await testDb.db
      .insert(gscDailyTotals)
      .values({ ...gscDay("2026-10-01"), projectId: "other-project" });
    await archived("inspection", "url_inspection");
    await archived("ga4", "ga4_landing_pages");
    await archived("overview", "domain_overview");

    await deleteSearchConsoleCopies(project);

    expect(await testDb.db.select().from(gscDailyRows)).toEqual([]);
    expect(
      (await testDb.db.select().from(gscDailyTotals)).map(
        (row) => row.projectId,
      ),
    ).toEqual(["other-project"]);
    expect(await archiveIds()).toEqual(["ga4", "overview"]);
    expect(objects.has("research-archive/project/inspection.json")).toBe(false);
    expect(objects.size).toBe(2);
    expect(await deletions()).toEqual([
      {
        projectId: project,
        tableName: "gsc_daily_totals",
        scope: { all: true },
      },
      { projectId: project, tableName: "gsc_daily_rows", scope: { all: true } },
      {
        projectId: project,
        tableName: "research_archive_entries",
        scope: { ids: ["inspection"] },
      },
    ]);
  });

  it("records nothing when the project has no Search Console copies", async () => {
    await deleteSearchConsoleCopies(project);

    expect(await deletions()).toEqual([]);
  });
});

describe("GA4 disconnect", () => {
  it("deletes the archived GA4 reports and their stored objects", async () => {
    await archived("ga4-a", "ga4_landing_pages");
    await archived("ga4-b", "ga4_landing_pages");
    await archived(
      "ga4-other",
      "ga4_landing_pages",
      undefined,
      "other-project",
    );
    await archived("inspection", "url_inspection");

    await deleteGa4Copies(project);

    expect(await archiveIds()).toEqual(["ga4-other", "inspection"]);
    expect(objects.size).toBe(2);
    expect(await deletions()).toEqual([
      {
        projectId: project,
        tableName: "research_archive_entries",
        scope: { ids: ["ga4-a", "ga4-b"] },
      },
    ]);
  });
});

describe("retention", () => {
  it("records expired archive entries per project", async () => {
    await archived("old", "domain_overview", "2025-01-01T00:00:00.000Z");
    await archived(
      "old-other",
      "domain_overview",
      "2025-01-01T00:00:00.000Z",
      "other-project",
    );
    await archived("recent", "domain_overview");

    await pruneResearchArchive(new Date("2026-10-21T00:00:00.000Z"));

    expect(await archiveIds()).toEqual(["recent"]);
    expect(await deletions()).toEqual(
      expect.arrayContaining([
        {
          projectId: project,
          tableName: "research_archive_entries",
          scope: { ids: ["old"] },
        },
        {
          projectId: "other-project",
          tableName: "research_archive_entries",
          scope: { ids: ["old-other"] },
        },
      ]),
    );
  });

  it("records snapshot retention only for the tables it emptied", async () => {
    const market = { locationCode: 2826, languageCode: "en" };
    await testDb.db.insert(domainSnapshots).values([
      {
        projectId: project,
        domain: "openseo.so",
        ...market,
        capturedOn: "2025-01-01",
      },
      {
        projectId: project,
        domain: "openseo.so",
        ...market,
        capturedOn: "2026-10-01",
      },
    ]);
    await testDb.db.insert(keywordMetricSnapshots).values({
      projectId: project,
      keyword: "seo",
      ...market,
      capturedOn: "2026-10-01",
    });

    await ResearchHistoryRepository.pruneProjectBefore(project, "2025-09-29");

    expect(
      (await testDb.db.select().from(domainSnapshots)).map(
        (row) => row.capturedOn,
      ),
    ).toEqual(["2026-10-01"]);
    expect(await deletions()).toEqual([
      {
        projectId: project,
        tableName: "domain_snapshots",
        scope: { before: "2025-09-29" },
      },
    ]);
  });
});
