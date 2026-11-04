import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { responseForAppError } from "@/server/lib/http-errors";
import {
  DATAFORSEO_SANDBOX_BASE,
  dataforseoPost,
} from "@/server/lib/dataforseo/core";
import { readDataforseoSpend } from "@/server/lib/dataforseo/spend-ledger";
import { runAsDataforseoCaller } from "@/server/lib/dataforseo/spend-caller";
import {
  DataforseoSpendCapError,
  holdDataforseoSpend,
} from "@/server/lib/dataforseo/spend-cap";
import {
  at,
  currentMonth,
  RELATED,
  relatedTask,
} from "@/server/lib/dataforseo/spend-cap.testkit";

// The real cap (the shared test setup stubs it out for every other test),
// against in-memory SQLite with every production migration applied.
vi.unmock("@/server/lib/dataforseo/spend-cap");

const { kit } = await vi.hoisted(async () => {
  const { createSpendTestKit } =
    await import("@/server/lib/dataforseo/spend-cap.testkit");
  return { kit: await createSpendTestKit() };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1", R2: kit.bucket },
  waitUntil: () => undefined,
}));
vi.mock("@/db", () => ({ db: kit.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: kit.runBatch,
  runClaimed: kit.runClaimed,
}));
vi.mock("@/server/lib/provider-access", () => ({
  getDataforseoFetch: async () => kit.dataforseoFetch,
}));

const { monthRow, ledger } = kit;
const relatedHold = (now?: () => Date) =>
  holdDataforseoSpend(
    { method: "POST", path: RELATED, body: relatedTask() },
    now,
  );

beforeEach(async () => {
  await kit.reset();
  vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "25");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ledger accounting", () => {
  it("holds the estimate, then books the cost DataForSEO reports", async () => {
    const hold = await relatedHold(at("2026-11-04T10:00:00Z"));
    expect(await monthRow("2026-11")).toMatchObject({
      reservedMicros: 24_000,
      spentMicros: 0,
    });

    await hold.settle({ cost: 0.0131, tasks: [{ cost: 0.0131 }] });

    expect(await monthRow("2026-11")).toMatchObject({
      spentMicros: 13_100,
      reservedMicros: 0,
      liveCalls: 1,
      refusedCalls: 0,
    });
    expect(await ledger()).toMatchObject([
      {
        month: "2026-11",
        caller: "background",
        path: RELATED,
        estimatedMicros: 24_000,
        costMicros: 13_100,
        costSource: "response",
        status: "settled",
      },
    ]);
  });

  it("sums task costs when the envelope has none, and books the estimate when neither is there", async () => {
    const summed = await relatedHold();
    await summed.settle({ tasks: [{ cost: 0.01 }, { cost: 0.002 }] });
    const unknown = await relatedHold();
    await unknown.settle({ tasks: [{}] });

    expect(await monthRow(currentMonth())).toMatchObject({
      spentMicros: 12_000 + 24_000,
      reservedMicros: 0,
      liveCalls: 2,
    });
    expect((await ledger()).map((row) => row.costSource)).toEqual([
      "response",
      "estimate",
    ]);
  });

  it("books nothing for a failure DataForSEO never ran, and the estimate for one it may have billed", async () => {
    const throttled = await relatedHold();
    await throttled.fail(new AppError("RATE_LIMITED"));
    const timedOut = await relatedHold();
    await timedOut.fail(new AppError("UPSTREAM_UNAVAILABLE", "timed out"));

    expect(await monthRow(currentMonth())).toMatchObject({
      spentMicros: 24_000,
      reservedMicros: 0,
      liveCalls: 2,
    });
    expect((await ledger()).map((row) => [row.status, row.costMicros])).toEqual(
      [
        ["failed", 0],
        ["failed", 24_000],
      ],
    );
  });

  it("labels each call with the caller it ran under", async () => {
    await runAsDataforseoCaller("mcp:get_keyword_metrics (node)", async () => {
      await (await relatedHold()).settle({ cost: 0.02 });
    });
    await runAsDataforseoCaller("app", async () => {
      await (await relatedHold()).settle({ cost: 0.01 });
    });
    await (await relatedHold()).settle({ cost: 0.005 });

    const summary = await readDataforseoSpend(currentMonth());
    expect(summary).toMatchObject({
      capUsd: 25,
      spentUsd: 0.035,
      reservedUsd: 0,
      remainingUsd: 24.965,
      capReached: false,
      liveCalls: 3,
      refusedCalls: 0,
    });
    expect(summary.callers).toEqual([
      {
        caller: "mcp:get_keyword_metrics (node)",
        liveCalls: 1,
        refusalsLogged: 0,
        pendingCalls: 0,
        spentUsd: 0.02,
      },
      {
        caller: "app",
        liveCalls: 1,
        refusalsLogged: 0,
        pendingCalls: 0,
        spentUsd: 0.01,
      },
      {
        caller: "background",
        liveCalls: 1,
        refusalsLogged: 0,
        pendingCalls: 0,
        spentUsd: 0.005,
      },
    ]);
  });

  it("records nothing for free requests, unless DataForSEO bills one", async () => {
    const collect = await holdDataforseoSpend({
      method: "GET",
      path: "/v3/serp/google/organic/task_get/advanced/abc",
      body: undefined,
    });
    await collect.settle({ cost: 0, tasks: [{ cost: 0 }] });
    expect(await ledger()).toEqual([]);
    expect(await monthRow(currentMonth())).toBeUndefined();

    const surprise = await holdDataforseoSpend({
      method: "GET",
      path: "/v3/appendix/user_data",
      body: undefined,
    });
    await surprise.settle({ cost: 0.001 });
    expect(await monthRow(currentMonth())).toMatchObject({
      spentMicros: 1_000,
      reservedMicros: 0,
      liveCalls: 1,
    });
  });

  it("ignores the sandbox host", async () => {
    const hold = await holdDataforseoSpend({
      method: "POST",
      path: "/v3/serp/google/organic/live/advanced",
      body: [{ keyword: "seo", depth: 10 }],
      sandbox: true,
    });
    await hold.settle({ cost: 0.002 });
    expect(await ledger()).toEqual([]);
  });
});

describe("cap refusal", () => {
  it("refuses a call that would take the month past the cap, with a typed error", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "0.05");
    await (await relatedHold()).settle({ cost: 0.024 });
    await relatedHold(); // in flight: $0.048 committed

    const refusal = await relatedHold().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(DataforseoSpendCapError);
    expect(refusal).toMatchObject({ code: "DATAFORSEO_SPEND_CAP_REACHED" });
    expect(refusal instanceof Error ? refusal.message : "").toMatch(
      /^DataForSEO monthly cap reached \(\$0\.05 of \$0\.05\)\. This request needs about \$0\.024\. Cached results still work; live DataForSEO calls resume on \d{4}-\d{2}-01 \(UTC\)\./,
    );
    expect(responseForAppError(refusal, "x").status).toBe(402);
    expect(await monthRow(currentMonth())).toMatchObject({
      spentMicros: 24_000,
      reservedMicros: 24_000,
      refusedCalls: 1,
    });
    expect((await ledger()).at(-1)).toMatchObject({
      status: "refused",
      costMicros: 0,
      estimatedMicros: 24_000,
    });
    expect(await readDataforseoSpend(currentMonth())).toMatchObject({
      capUsd: 0.05,
      remainingUsd: 0.002,
      refusedCalls: 1,
    });
  });

  it("formats a whole-dollar cap as the owner set it", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "25");
    await kit.client.execute(
      `INSERT INTO dataforseo_spend_months (month, spent_micros, updated_at) VALUES ('${currentMonth()}', 24990000, 'x')`,
    );
    await expect(relatedHold()).rejects.toThrow(
      /^DataForSEO monthly cap reached \(\$24\.99 of \$25\)/,
    );
  });

  it("refuses a single call bigger than the whole cap on a fresh month", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "0.01");
    await expect(relatedHold()).rejects.toMatchObject({
      code: "DATAFORSEO_SPEND_CAP_REACHED",
    });
    expect(await monthRow(currentMonth())).toMatchObject({
      spentMicros: 0,
      reservedMicros: 0,
      refusedCalls: 1,
    });
  });

  it("falls back to $25 on a cap setting that is not a number", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "unlimited");
    expect((await readDataforseoSpend(currentMonth())).capUsd).toBe(25);
  });

  it("never sends the request when the cap refuses it", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "0.01");
    const sent = vi.fn(async () => Response.json({ cost: 0.024, tasks: [] }));
    kit.upstream.fetch = sent;

    await expect(dataforseoPost(RELATED, relatedTask())).rejects.toMatchObject({
      code: "DATAFORSEO_SPEND_CAP_REACHED",
    });
    expect(sent).not.toHaveBeenCalled();
  });

  it("books a live request sent through the transport on its reported cost", async () => {
    kit.upstream.fetch = async () =>
      Response.json({ status_code: 20000, cost: 0.0156, tasks: [] });

    await runAsDataforseoCaller("mcp:research_keywords (node)", () =>
      dataforseoPost(RELATED, relatedTask()),
    );

    expect(await ledger()).toMatchObject([
      {
        caller: "mcp:research_keywords (node)",
        costMicros: 15_600,
        status: "settled",
      },
    ]);
  });

  it("treats only DataForSEO's sandbox host as free", async () => {
    kit.upstream.fetch = async () =>
      Response.json({ status_code: 20000, cost: 0.002, tasks: [] });
    const task = [{ keyword: "seo", depth: 10 }];
    const path = "/v3/serp/google/organic/live/advanced";

    await dataforseoPost(path, task, {
      baseUrl: DATAFORSEO_SANDBOX_BASE,
    });
    expect(await ledger()).toEqual([]);

    await dataforseoPost(path, task, { baseUrl: "https://dataforseo.example" });
    expect(await ledger()).toMatchObject([
      { path, costMicros: 2_000, status: "settled" },
    ]);
  });
});
