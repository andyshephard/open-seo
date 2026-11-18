import { beforeEach, describe, expect, it, vi } from "vitest";
import { clusterKeywordsBySerpTool } from "./cluster-keywords-by-serp";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getSavedKeywords: vi.fn(),
  readStoredSerp: vi.fn(),
  getSerpSnapshot: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/dataforseo", () => ({ SERP_ANALYSIS_DEPTH: 10 }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/keywords/services/KeywordResearchService", () => ({
  KeywordResearchService: { getSavedKeywords: mocks.getSavedKeywords },
}));
vi.mock("@/server/features/keywords/services/research/storedSerps", () => ({
  readStoredSerp: mocks.readStoredSerp,
  organicSerpRows: (items: { url: string }[]) =>
    items.map((item, i) => ({
      url: item.url,
      title: "t",
      domain: "d",
      position: i + 1,
    })),
}));
vi.mock("@/server/features/keywords/services/research/serpSnapshot", () => ({
  getSerpSnapshot: mocks.getSerpSnapshot,
}));

const toolContext = makeToolContext();
const keywords = ["a", "b", "c", "d"];

beforeEach(() => {
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "p",
    domain: "mine.com",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.getSavedKeywords.mockResolvedValue({
    rows: [],
    totalCount: 0,
    tags: [],
  });
  mocks.readStoredSerp.mockResolvedValue(null);
  mocks.getSerpSnapshot.mockResolvedValue({
    fetchedAt: "2026-11-18T00:00:00.000Z",
    items: [{ url: "https://x.com/p" }],
  });
});

describe("cluster_keywords_by_serp", () => {
  it("never buys a SERP with the defaults, and lists keywords without one as skipped", async () => {
    const result = await clusterKeywordsBySerpTool.handler(
      {
        projectId: "p",
        keywords,
        useCachedOnly: true,
        maxNewSerps: 0,
        maxAgeDays: 90,
      },
      toolContext,
    );
    expect(mocks.getSerpSnapshot).not.toHaveBeenCalled();
    expect(result.structuredContent.skipped).toHaveLength(4);
  });

  it("buys at most maxNewSerps when opted in", async () => {
    await clusterKeywordsBySerpTool.handler(
      {
        projectId: "p",
        keywords,
        useCachedOnly: false,
        maxNewSerps: 2,
        maxAgeDays: 90,
      },
      toolContext,
    );
    expect(mocks.getSerpSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not buy when useCachedOnly stays true, whatever maxNewSerps says", async () => {
    await clusterKeywordsBySerpTool.handler(
      {
        projectId: "p",
        keywords,
        useCachedOnly: true,
        maxNewSerps: 5,
        maxAgeDays: 90,
      },
      toolContext,
    );
    expect(mocks.getSerpSnapshot).not.toHaveBeenCalled();
  });
});
