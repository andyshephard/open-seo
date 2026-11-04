import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import type { RankCheckTaskInput } from "@/server/lib/dataforseo";
import { runQueuedCheck, runQueuedTasks } from "./rankCheckPaths";
import { retryRankChecks } from "./rankCheckRetries";

const mocks = vi.hoisted(() => ({
  getSnapshotsForRun: vi.fn(),
  getBestPositionsForKeywords: vi.fn(),
  insertSnapshots: vi.fn(),
  updateRun: vi.fn(),
  upsertSnapshots: vi.fn(),
  deleteNotFoundSnapshots: vi.fn(),
  fetchRankCheckTaskResult: vi.fn(),
  rankCheckTaskPost: vi.fn(),
  archiveLookup: vi.fn(),
  getCachedEntry: vi.fn(),
  setCached: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: mocks }),
);
vi.mock("@/server/lib/dataforseo", () => ({
  fetchRankCheckTaskResult: mocks.fetchRankCheckTaskResult,
  MAX_TASKS_PER_POST: 100,
}));
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
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only sleep is reached; pgStep is mocked
const step = { sleep: vi.fn() } as unknown as WorkflowStep;

function checkContext(
  keywordIds: string[],
  devices: "desktop" | "both" = "desktop",
) {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the check paths only call this serp method
    client: { serp: { rankCheckTaskPost: mocks.rankCheckTaskPost } } as never,
    billingCustomer: {
      userId: "user_1",
      userEmail: "owner@example.com",
      organizationId: "org_1",
      projectId: "project_1",
    },
    configId: "config_1",
    keywords: keywordIds.map((id) => ({ id, keyword: `keyword ${id}` })),
    devices,
    serpDepth: 10,
    domain: "openseo.so",
    locationCode: 2840,
    languageCode: "en",
    runId: "run_1",
  };
}

function snapshot(keywordId: string, position: number | null) {
  return { trackingKeywordId: keywordId, device: "desktop", position };
}

/** Each task_get answers with the next position. */
function queuedResults(...positions: Array<number | null>) {
  for (const position of positions) {
    mocks.fetchRankCheckTaskResult.mockImplementationOnce(
      async (task: RankCheckTaskInput) => ({
        status: "completed",
        result: { ...task, position, url: null, serpFeatures: [] },
      }),
    );
  }
}

function retry(ctx: ReturnType<typeof checkContext>, readsEndAt = Infinity) {
  return retryRankChecks(step, ctx, "config_1", readsEndAt);
}

beforeEach(() => {
  mocks.getCachedEntry.mockResolvedValue(null);
  mocks.setCached.mockResolvedValue(undefined);
  mocks.rankCheckTaskPost.mockImplementation(
    async ({ tasks }: { tasks: RankCheckTaskInput[] }) =>
      tasks.map((task) => ({ ...task, taskId: `task_${task.keywordId}` })),
  );
  mocks.fetchRankCheckTaskResult.mockImplementation(
    async (task: RankCheckTaskInput) => ({
      status: "completed",
      result: { ...task, position: null, url: null, serpFeatures: [] },
    }),
  );
  mocks.getBestPositionsForKeywords.mockResolvedValue([
    { trackingKeywordId: "kw_0", position: 1 },
    { trackingKeywordId: "kw_never", position: null },
  ]);
});

describe("shared results pages", () => {
  it("answers a pair from a page another tracker bought today without a paid check", async () => {
    mocks.getCachedEntry.mockImplementation(async (key: string) =>
      key === "rank-serp:keyword kw_0"
        ? {
            value: {
              depth: 10,
              items: [
                {
                  type: "organic",
                  rankGroup: 4,
                  rankAbsolute: 6,
                  domain: "www.openseo.so",
                  url: "https://www.openseo.so/",
                  title: "OpenSEO",
                },
              ],
            },
          }
        : null,
    );

    await runQueuedCheck(step, checkContext(["kw_0", "kw_1"]));

    expect(mocks.insertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({ trackingKeywordId: "kw_0", position: 4 }),
    ]);
    expect(mocks.rankCheckTaskPost).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [expect.objectContaining({ keywordId: "kw_1" })],
      }),
    );
  });
});

describe("runQueuedTasks", () => {
  it("archives each collected results page and keeps it out of the step output", async () => {
    const page = [
      {
        type: "organic",
        rankGroup: 1,
        rankAbsolute: 1,
        domain: "openseo.so",
        url: "https://openseo.so/",
        title: "OpenSEO",
      },
    ];
    mocks.fetchRankCheckTaskResult.mockImplementationOnce(
      async (task: RankCheckTaskInput) => ({
        status: "completed",
        result: {
          ...task,
          position: 1,
          url: null,
          serpFeatures: [],
          serpItems: page,
        },
      }),
    );
    const archived: unknown[] = [];
    const taskIds: unknown[] = [];

    const collected = await runQueuedTasks(
      step,
      checkContext(["kw_0"]),
      [{ keyword: "keyword kw_0", keywordId: "kw_0", device: "desktop" }],
      "",
      async (results) => {
        archived.push(...results.map((result) => result.serpItems));
        taskIds.push(...results.map((result) => result.taskId));
      },
    );

    expect(archived).toEqual([page]);
    // The archive keys each entry on it, so a retried collect step re-records
    // the same entry instead of a duplicate.
    expect(taskIds).toEqual(["task_kw_0"]);
    expect(collected).toEqual([
      expect.objectContaining({ keywordId: "kw_0", serpItems: [] }),
    ]);
  });
});

describe("retryRankChecks", () => {
  it("gives a keyword three reads even when the first looks fine, then stops once they agree", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([snapshot("kw_new", 5)]);
    queuedResults(4, 6);

    await retry(checkContext(["kw_new"]));

    expect(mocks.rankCheckTaskPost).toHaveBeenCalledTimes(2);
    expect(mocks.upsertSnapshots).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ trackingKeywordId: "kw_new", position: 4 }),
    ]);
  });

  it.each([
    ["positions differ by more than two places", [3, 9, 8, 7, 6]],
    ["a read misses the site", [null, 3, 5, 5, 5]],
  ])(
    "reads up to six times when %s, keeping the best position",
    async (_label, laterReads) => {
      mocks.getSnapshotsForRun.mockResolvedValue([snapshot("kw_new", 5)]);
      queuedResults(...laterReads);

      await retry(checkContext(["kw_new"]));

      expect(mocks.rankCheckTaskPost).toHaveBeenCalledTimes(5);
      expect(mocks.upsertSnapshots).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ position: 3 }),
      ]);
    },
  );

  it("starts no more reads once the read window has passed, and still drops misses", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([snapshot("kw_0", null)]);

    await retry(checkContext(["kw_0"]), Date.now() - 1);

    expect(mocks.rankCheckTaskPost).not.toHaveBeenCalled();
    expect(mocks.deleteNotFoundSnapshots).toHaveBeenCalledExactlyOnceWith([
      { runId: "run_1", trackingKeywordId: "kw_0", device: "desktop" },
    ]);
  });

  it("saves a not found for a keyword that never ranked once a read answers", async () => {
    // The first read errored, so there is no row yet.
    mocks.getSnapshotsForRun.mockResolvedValue([]);

    await retry(checkContext(["kw_never"]));

    expect(mocks.rankCheckTaskPost).toHaveBeenCalledTimes(5);
    expect(mocks.upsertSnapshots).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        trackingKeywordId: "kw_never",
        position: null,
      }),
    ]);
    expect(mocks.deleteNotFoundSnapshots).not.toHaveBeenCalled();
  });

  it("finds a new keyword on a later read after earlier ones miss", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([snapshot("kw_new", null)]);
    queuedResults(null, null, null, 3, null);

    await retry(checkContext(["kw_new"]));

    expect(mocks.upsertSnapshots).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ trackingKeywordId: "kw_new", position: 3 }),
    ]);
    expect(mocks.deleteNotFoundSnapshots).not.toHaveBeenCalled();
  });

  it("never saves a not found for a keyword that ranked before", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([snapshot("kw_0", null)]);

    await retry(checkContext(["kw_0"]));

    expect(mocks.rankCheckTaskPost).toHaveBeenCalledTimes(5);
    expect(mocks.upsertSnapshots).not.toHaveBeenCalled();
    expect(mocks.deleteNotFoundSnapshots).toHaveBeenCalledExactlyOnceWith([
      { runId: "run_1", trackingKeywordId: "kw_0", device: "desktop" },
    ]);
  });

  it("drops a device's miss when the keyword ranks on the other device in this run", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([
      snapshot("kw_never", null),
      { ...snapshot("kw_never", 3), device: "mobile" },
    ]);

    await retry(checkContext(["kw_never"], "both"));

    expect(mocks.deleteNotFoundSnapshots).toHaveBeenCalledExactlyOnceWith([
      { runId: "run_1", trackingKeywordId: "kw_never", device: "desktop" },
    ]);
  });
});
