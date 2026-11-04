import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RankCheckSerpItem } from "@/server/lib/dataforseo/serp";
import {
  archiveSerps,
  reuseSharedSerps,
  type CheckContext,
} from "./rankCheckSerpReuse";

const mocks = vi.hoisted(() => ({
  insertSnapshots: vi.fn(),
  archiveLookup:
    vi.fn<(customer: unknown, entry: unknown) => Promise<boolean>>(),
  getCachedEntry: vi.fn(),
  setCached: vi.fn<(key: string, value: unknown) => Promise<void>>(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: { insertSnapshots: mocks.insertSnapshots },
  }),
);
vi.mock("@/server/features/research-history/services/researchArchive", () => ({
  archiveLookup: mocks.archiveLookup,
}));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: async (_prefix: string, parts: { keyword: string }) =>
    `rank-serp:${parts.keyword}`,
  getCachedEntry: mocks.getCachedEntry,
  setCached: mocks.setCached,
  RESEARCH_FRESHNESS_SECONDS: { serp: 86_400 },
}));

const task = {
  keyword: "seo tools",
  keywordId: "kw_0",
  device: "desktop" as const,
};

function context(domain: string, serpDepth = 20): CheckContext {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- reuse and archiving never call the provider
    client: {} as CheckContext["client"],
    billingCustomer: {
      userId: "user_1",
      userEmail: "owner@example.com",
      organizationId: "org_1",
      projectId: "project_1",
    },
    configId: "config_1",
    keywords: [{ id: "kw_0", keyword: "seo tools" }],
    devices: "desktop",
    serpDepth,
    domain,
    locationCode: 2840,
    languageCode: "en",
    runId: "run_1",
  };
}

function organic(domain: string, rankGroup: number): RankCheckSerpItem {
  return {
    type: "organic",
    rankGroup,
    rankAbsolute: rankGroup,
    domain,
    url: `https://${domain}/`,
    title: domain,
  };
}

/** A page another tracker stored today. */
function storedPage(value: Record<string, unknown>) {
  mocks.getCachedEntry.mockResolvedValue({ value });
}

beforeEach(() => {
  mocks.getCachedEntry.mockResolvedValue(null);
  mocks.setCached.mockResolvedValue(undefined);
  mocks.archiveLookup.mockResolvedValue(true);
});

describe("reuseSharedSerps", () => {
  it("buys a check when the stored page stopped at another tracker's domain", async () => {
    // openseo.so's tracker bought it: the crawl stopped at #3, so rival.io
    // being absent proves nothing about pages 2+.
    storedPage({
      depth: 20,
      truncated: true,
      items: [organic("openseo.so", 3)],
    });

    const remaining = await reuseSharedSerps(context("rival.io"), [task]);

    expect(remaining).toEqual([task]);
    expect(mocks.insertSnapshots).not.toHaveBeenCalled();
  });

  it("reuses a stopped page that shows the tracker's own domain", async () => {
    storedPage({
      depth: 20,
      truncated: true,
      items: [organic("www.rival.io", 2), organic("openseo.so", 3)],
    });

    const remaining = await reuseSharedSerps(context("rival.io"), [task]);

    expect(remaining).toEqual([]);
    expect(mocks.insertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({ trackingKeywordId: "kw_0", position: 2 }),
    ]);
  });

  it("reuses a complete page as not ranking", async () => {
    storedPage({
      depth: 20,
      truncated: false,
      items: [organic("openseo.so", 3)],
    });

    const remaining = await reuseSharedSerps(context("rival.io"), [task]);

    expect(remaining).toEqual([]);
    expect(mocks.insertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({ position: null, url: null }),
    ]);
  });

  it("buys a check when a complete page is shallower than the tracker's depth", async () => {
    storedPage({ depth: 10, truncated: false, items: [] });

    expect(await reuseSharedSerps(context("rival.io", 20), [task])).toEqual([
      task,
    ]);
  });

  it("treats a page stored without the truncation flag as stopped early", async () => {
    storedPage({ depth: 100, items: [organic("openseo.so", 3)] });

    expect(await reuseSharedSerps(context("rival.io"), [task])).toEqual([task]);
  });

  it("reads a rank past the tracker's depth on a deeper page as not ranking", async () => {
    storedPage({
      depth: 100,
      truncated: false,
      items: [organic("openseo.so", 3), organic("rival.io", 85)],
    });

    const remaining = await reuseSharedSerps(context("rival.io", 20), [task]);

    expect(remaining).toEqual([]);
    expect(mocks.insertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({ position: null, url: null }),
    ]);
  });

  it("buys a check for a stopped page whose only match is past the tracker's depth", async () => {
    storedPage({
      depth: 100,
      truncated: true,
      items: [organic("rival.io", 85)],
    });

    expect(await reuseSharedSerps(context("rival.io", 20), [task])).toEqual([
      task,
    ]);
  });
});

describe("archiveSerps", () => {
  const result = (position: number | null, taskId?: string) => ({
    keywordId: "kw_0",
    keyword: "seo tools",
    device: "desktop" as const,
    position,
    url: null,
    serpFeatures: [],
    serpItems: position ? [organic("openseo.so", position)] : [],
    taskId,
  });

  it("marks a shared page truncated when the crawl found the tracker's domain", async () => {
    await archiveSerps(context("openseo.so"), [result(3), result(null)]);

    expect(mocks.setCached.mock.calls.map(([, value]) => value)).toEqual([
      expect.objectContaining({ depth: 20, truncated: true }),
      expect.objectContaining({ depth: 20, truncated: false }),
    ]);
  });

  it("keys a queued task's archive entry on its task id", async () => {
    await archiveSerps(context("openseo.so"), [result(3, "task_1")], false);
    await archiveSerps(context("openseo.so"), [result(3)], false);

    expect(mocks.archiveLookup.mock.calls.map(([, entry]) => entry)).toEqual([
      expect.objectContaining({ entryKey: "task:task_1" }),
      expect.objectContaining({ entryKey: undefined }),
    ]);
    expect(mocks.setCached).not.toHaveBeenCalled();
  });
});
