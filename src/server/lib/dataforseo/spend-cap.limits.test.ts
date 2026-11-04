import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCached, setCached } from "@/server/lib/r2-cache";
import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  readDataforseoSpend,
  sweepDataforseoSpend,
} from "@/server/lib/dataforseo/spend-ledger";
import { holdDataforseoSpend } from "@/server/lib/dataforseo/spend-cap";
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

describe("at the cap, reads that need no paid call keep working", () => {
  // The shape every cached research read has: the provider cache first, a
  // live call only on a miss.
  async function readThroughCache(keyword: string) {
    const key = `related:${keyword}`;
    const cached = await getCached(key);
    if (cached) return { source: "cache", value: cached };
    const live = await dataforseoPost(RELATED, relatedTask(keyword));
    await setCached(key, live, 3600);
    return { source: "live", value: live };
  }

  it("serves a cached result, and refuses only the uncached one", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "0.03");
    const sent = vi.fn(async () =>
      Response.json({ status_code: 20000, cost: 0.024, tasks: [] }),
    );
    kit.upstream.fetch = sent;

    expect(await readThroughCache("seo")).toMatchObject({ source: "live" });
    // $0.024 of $0.03 spent: the next live call ($0.024) no longer fits.
    expect(await readThroughCache("seo")).toMatchObject({
      source: "cache",
      value: { cost: 0.024 },
    });
    await expect(readThroughCache("audio stories")).rejects.toMatchObject({
      code: "DATAFORSEO_SPEND_CAP_REACHED",
    });
    expect(sent).toHaveBeenCalledOnce();
  });

  it("still collects queued tasks, which DataForSEO bills at posting", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "0");
    kit.upstream.fetch = async () =>
      Response.json({ status_code: 20000, cost: 0, tasks: [] });

    await expect(
      dataforseoGet("/v3/serp/google/organic/task_get/advanced/task-1"),
    ).resolves.toMatchObject({ status_code: 20000 });
  });
});

describe("month rollover", () => {
  it("starts each UTC month with the full cap, and books a call to the month it was held in", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "0.05");
    await (
      await relatedHold(at("2026-10-31T23:58:00Z"))
    ).settle({
      cost: 0.024,
    });
    const straddling = await relatedHold(at("2026-10-31T23:59:59Z"));
    await expect(relatedHold(at("2026-10-31T23:59:59Z"))).rejects.toThrow(
      /cap reached/,
    );

    // A second into November there is a fresh cap.
    const november = await relatedHold(at("2026-11-01T00:00:01Z"));
    await november.settle({ cost: 0.02 });
    await straddling.settle({ cost: 0.024 });

    expect(await monthRow("2026-10")).toMatchObject({
      spentMicros: 48_000,
      reservedMicros: 0,
      liveCalls: 2,
      refusedCalls: 1,
    });
    expect(await monthRow("2026-11")).toMatchObject({
      spentMicros: 20_000,
      reservedMicros: 0,
      liveCalls: 1,
      refusedCalls: 0,
    });
    expect(await readDataforseoSpend("2026-11")).toMatchObject({
      resetsAt: "2026-12-01T00:00:00.000Z",
      remainingUsd: 0.03,
    });
  });

  it("rolls the year over", async () => {
    await relatedHold(at("2026-12-31T23:59:59Z"));
    await relatedHold(at("2027-01-01T00:00:00Z"));
    expect(await monthRow("2026-12")).toBeDefined();
    expect(await monthRow("2027-01")).toBeDefined();
    expect((await readDataforseoSpend("2026-12")).resetsAt).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("concurrency", () => {
  it("lets only as many concurrent calls through as fit under the cap", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "1");
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => relatedHold()),
    );

    const held = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    // floor($1 / $0.024) = 41
    expect(held).toHaveLength(41);
    expect(refused).toHaveLength(59);
    for (const result of refused)
      expect(result.reason).toMatchObject({
        code: "DATAFORSEO_SPEND_CAP_REACHED",
      });
    const row = await monthRow(currentMonth());
    expect(row.spentMicros + row.reservedMicros).toBe(41 * 24_000);
    expect(row.refusedCalls).toBe(59);
    // One caller, one hour: the ledger logs only its first refusal.
    const statuses = (await ledger()).map((entry) => entry.status);
    expect(statuses.filter((status) => status === "refused")).toHaveLength(1);
    expect(statuses.filter((status) => status === "pending")).toHaveLength(41);

    // Settling them all at the estimate keeps the month under the cap.
    await Promise.all(
      held.map((result) =>
        result.status === "fulfilled" ? result.value.settleAtEstimate() : null,
      ),
    );
    expect(await monthRow(currentMonth())).toMatchObject({
      spentMicros: 41 * 24_000,
      reservedMicros: 0,
      liveCalls: 41,
    });
  });

  it("books a hold once when the call and the sweep close it together", async () => {
    const hold = await relatedHold(at("2026-11-04T10:00:00Z"));
    await Promise.all([
      hold.settle({ cost: 0.01 }),
      sweepDataforseoSpend(new Date("2026-11-04T12:00:00Z")),
    ]);
    const row = await monthRow("2026-11");
    expect(row.liveCalls).toBe(1);
    expect(row.reservedMicros).toBe(0);
    expect([10_000, 24_000]).toContain(row.spentMicros);
  });
});
