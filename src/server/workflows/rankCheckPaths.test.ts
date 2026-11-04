import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import type { RankCheckTaskInput } from "@/server/lib/dataforseo";
import { runLiveCheck, runQueuedTasks } from "./rankCheckPaths";
import { retryRankChecks } from "./rankCheckRetries";

const mocks = vi.hoisted(() => ({
  getSnapshotsForRun: vi.fn(),
  getBestPositionsForKeywords: vi.fn(),
  insertSnapshots: vi.fn(),
  upsertSnapshots: vi.fn(),
  deleteNotFoundSnapshots: vi.fn(),
  setRunErrorIfEmpty: vi.fn(),
  updateRun: vi.fn(),
  fetchRankCheckTaskResult: vi.fn(),
  rankCheckBatch: vi.fn(),
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

function checkContext(keywordIds: string[]) {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the check paths only call these two serp methods
    client: {
      serp: {
        rankCheckBatch: mocks.rankCheckBatch,
        rankCheckTaskPost: mocks.rankCheckTaskPost,
      },
    } as never,
    billingCustomer: {
      userId: "user_1",
      userEmail: "owner@example.com",
      organizationId: "org_1",
      projectId: "project_1",
    },
    configId: "config_1",
    keywords: keywordIds.map((id) => ({ id, keyword: `keyword ${id}` })),
    devices: "desktop" as const,
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

beforeEach(() => {
  mocks.getCachedEntry.mockResolvedValue(null);
  mocks.setCached.mockResolvedValue(undefined);
  mocks.rankCheckBatch.mockImplementation(
    async (inputs: RankCheckTaskInput[]) =>
      inputs.map((input) => ({
        status: "fulfilled",
        value: { ...input, position: 3, url: null, serpFeatures: [] },
      })),
  );
  mocks.rankCheckTaskPost.mockImplementation(
    async ({ tasks }: { tasks: RankCheckTaskInput[] }) =>
      tasks.map((task) => ({ ...task, taskId: `task_${task.keywordId}` })),
  );
  mocks.fetchRankCheckTaskResult.mockImplementation(
    async (task: RankCheckTaskInput) => ({
      status: "completed",
      result: { ...task, position: 5, url: null, serpFeatures: [] },
    }),
  );
  mocks.getBestPositionsForKeywords.mockResolvedValue([
    { trackingKeywordId: "kw_0", position: 1 },
    { trackingKeywordId: "kw_never", position: null },
  ]);
});

describe("runLiveCheck", () => {
  it("keeps going after a failed live batch", async () => {
    mocks.insertSnapshots.mockRejectedValueOnce(new Error("step timed out"));

    await runLiveCheck(
      step,
      checkContext(Array.from({ length: 11 }, (_, i) => `kw_${i}`)),
    );

    expect(mocks.rankCheckBatch).toHaveBeenCalledTimes(2);
  });
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

    await runLiveCheck(step, checkContext(["kw_0", "kw_1"]));

    expect(mocks.insertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({ trackingKeywordId: "kw_0", position: 4 }),
    ]);
    expect(mocks.rankCheckBatch).toHaveBeenCalledWith([
      expect.objectContaining({ keywordId: "kw_1" }),
    ]);
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
    const ctx = checkContext(["kw_0"]);
    const archived: unknown[] = [];
    const taskIds: unknown[] = [];

    const collected = await runQueuedTasks(
      step,
      ctx,
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
  it("retries a check that errored through the queue, keeping a not found for a keyword that never ranked", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([]);
    queuedResults(null);

    await retryRankChecks(
      step,
      checkContext(["kw_never"]),
      "config_1",
      "scheduled",
    );

    expect(mocks.rankCheckBatch).not.toHaveBeenCalled();
    expect(mocks.rankCheckTaskPost).toHaveBeenCalledOnce();
    expect(mocks.upsertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({
        trackingKeywordId: "kw_never",
        position: null,
      }),
    ]);
    expect(mocks.deleteNotFoundSnapshots).not.toHaveBeenCalled();
  });

  it("retries a keyword that lost its known rank and keeps the best position found", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([
      snapshot("kw_0", null),
      snapshot("kw_never", null),
    ]);
    queuedResults(15, 20);

    await retryRankChecks(
      step,
      checkContext(["kw_0", "kw_never"]),
      "config_1",
      "scheduled",
    );

    // 15 is still far below #1, so it gets the second retry too.
    expect(mocks.rankCheckTaskPost).toHaveBeenCalledTimes(2);
    expect(mocks.rankCheckTaskPost).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [expect.objectContaining({ keywordId: "kw_0" })],
      }),
    );
    expect(mocks.upsertSnapshots).toHaveBeenCalledOnce();
    expect(mocks.upsertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({ trackingKeywordId: "kw_0", position: 15 }),
    ]);
  });

  it("retries a device's miss once a retry finds the keyword on the other device", async () => {
    // Desktop missed on the first check and mobile errored.
    mocks.getSnapshotsForRun.mockResolvedValue([snapshot("kw_never", null)]);
    // Retry 1 answers mobile at #3; retry 2 answers desktop.
    queuedResults(3, null);

    await retryRankChecks(
      step,
      { ...checkContext(["kw_never"]), devices: "both" },
      "config_1",
      "scheduled",
    );

    expect(mocks.rankCheckTaskPost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tasks: [expect.objectContaining({ device: "desktop" })],
      }),
    );
    expect(mocks.deleteNotFoundSnapshots).toHaveBeenCalledWith([
      { runId: "run_1", trackingKeywordId: "kw_never", device: "desktop" },
    ]);
  });

  it("finds a new keyword on its second recheck after the first recheck misses", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([snapshot("kw_new", null)]);
    queuedResults(null, 3);

    await retryRankChecks(
      step,
      checkContext(["kw_new"]),
      "config_1",
      "scheduled",
    );

    expect(mocks.rankCheckTaskPost).toHaveBeenCalledTimes(2);
    expect(mocks.upsertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({ trackingKeywordId: "kw_new", position: 3 }),
    ]);
    expect(mocks.deleteNotFoundSnapshots).not.toHaveBeenCalled();
  });

  it("rechecks a miss on a keyword that never ranked when the check is manual", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([snapshot("kw_never", null)]);
    queuedResults(null, 4);

    await retryRankChecks(
      step,
      checkContext(["kw_never"]),
      "config_1",
      "manual",
    );

    expect(mocks.rankCheckTaskPost).toHaveBeenCalledTimes(2);
    expect(mocks.upsertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({ trackingKeywordId: "kw_never", position: 4 }),
    ]);
  });

  it("never saves a not found for a keyword that ranked before", async () => {
    mocks.getSnapshotsForRun.mockResolvedValue([snapshot("kw_0", null)]);
    queuedResults(null, null);

    await retryRankChecks(
      step,
      checkContext(["kw_0"]),
      "config_1",
      "scheduled",
    );

    expect(mocks.rankCheckTaskPost).toHaveBeenCalledTimes(2);
    expect(mocks.upsertSnapshots).not.toHaveBeenCalled();
    expect(mocks.deleteNotFoundSnapshots).toHaveBeenCalledWith([
      { runId: "run_1", trackingKeywordId: "kw_0", device: "desktop" },
    ]);
  });
});
