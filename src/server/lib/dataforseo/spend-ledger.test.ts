import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pruneDataforseoSpendLedger,
  readDataforseoSpend,
  sweepDataforseoSpend,
} from "@/server/lib/dataforseo/spend-ledger";
import { runAsDataforseoCaller } from "@/server/lib/dataforseo/spend-caller";
import { holdDataforseoSpend } from "@/server/lib/dataforseo/spend-cap";
import {
  at,
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

// Moves a table away and back, to make every statement on it fail.
async function withTableGone(table: string, fn: () => Promise<unknown>) {
  await kit.client.execute(`ALTER TABLE ${table} RENAME TO ${table}_away`);
  try {
    await fn();
  } finally {
    await kit.client.execute(`ALTER TABLE ${table}_away RENAME TO ${table}`);
  }
}

describe("sweep", () => {
  it("books holds that never settled at their estimate, and leaves recent ones", async () => {
    await relatedHold(at("2026-11-04T08:00:00Z")); // worker died mid-call
    await relatedHold(at("2026-11-04T09:45:00Z")); // still in flight

    expect(
      await sweepDataforseoSpend(new Date("2026-11-04T10:00:00Z")),
    ).toEqual({ abandoned: 1 });

    expect(await monthRow("2026-11")).toMatchObject({
      spentMicros: 24_000,
      reservedMicros: 24_000,
      liveCalls: 1,
    });
    expect((await ledger()).map((row) => row.status)).toEqual([
      "abandoned",
      "pending",
    ]);
  });

  it("rebuilds this month's and last month's totals from the ledger", async () => {
    await (
      await relatedHold(at("2026-10-20T00:00:00Z"))
    ).settle({
      cost: 0.01,
    });
    await (
      await relatedHold(at("2026-11-04T09:00:00Z"))
    ).settle({
      cost: 0.02,
    });
    await relatedHold(at("2026-11-04T09:59:00Z")); // in flight
    // Drift, e.g. a settle that never reached the month row.
    await kit.client.execute(
      "UPDATE dataforseo_spend_months SET spent_micros = 999999, reserved_micros = 5, live_calls = 9, refused_calls = 3",
    );

    await sweepDataforseoSpend(new Date("2026-11-04T10:00:00Z"));

    expect(await monthRow("2026-11")).toMatchObject({
      spentMicros: 20_000,
      reservedMicros: 24_000,
      liveCalls: 1,
      // Refusals are not all in the ledger, so their count is kept.
      refusedCalls: 3,
    });
    expect(await monthRow("2026-10")).toMatchObject({
      spentMicros: 10_000,
      reservedMicros: 0,
      liveCalls: 1,
    });
  });

  it("counts a hold from the moment its ledger row exists", async () => {
    const hold = await relatedHold(at("2026-11-04T10:00:00Z"));
    await sweepDataforseoSpend(new Date("2026-11-04T10:00:01Z"));
    expect((await monthRow("2026-11")).reservedMicros).toBe(24_000);
    await hold.settle({ cost: 0.01 });
    expect(await monthRow("2026-11")).toMatchObject({
      spentMicros: 10_000,
      reservedMicros: 0,
    });
  });

  it("drops ledger rows past 13 months and keeps the month totals", async () => {
    await (
      await relatedHold(at("2025-09-15T00:00:00Z"))
    ).settle({
      cost: 0.01,
    });
    await (
      await relatedHold(at("2025-10-15T00:00:00Z"))
    ).settle({
      cost: 0.01,
    });

    await pruneDataforseoSpendLedger(new Date("2026-11-04T10:00:00Z"));

    expect((await ledger()).map((row) => row.month)).toEqual(["2025-10"]);
    expect(await monthRow("2025-09")).toMatchObject({ spentMicros: 10_000 });
  });
});

describe("atomic writes", () => {
  it("leaves a hold pending when its month update fails, so nothing is half-booked", async () => {
    const hold = await relatedHold(at("2026-11-04T10:00:00Z"));
    await withTableGone("dataforseo_spend_months", () =>
      hold.settle({ cost: 0.01 }),
    );
    expect((await ledger()).map((row) => row.status)).toEqual(["pending"]);
    expect(await monthRow("2026-11")).toMatchObject({
      reservedMicros: 24_000,
      spentMicros: 0,
      liveCalls: 0,
    });
  });

  it("drops the pending row when the reservation fails", async () => {
    await withTableGone("dataforseo_spend_months", async () => {
      await expect(relatedHold()).rejects.toThrow();
    });
    expect(await ledger()).toEqual([]);
  });
});

describe("refusal log", () => {
  it("logs one refusal per caller per hour, and counts every one", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "0.01");
    const refuseAt = (iso: string) => relatedHold(at(iso)).catch(() => null);
    await refuseAt("2026-11-04T10:00:00Z");
    await refuseAt("2026-11-04T10:30:00Z");
    await runAsDataforseoCaller("app", () => refuseAt("2026-11-04T10:31:00Z"));
    await refuseAt("2026-11-04T11:00:01Z");

    expect(
      (await ledger()).map((row) => [row.caller, row.status, row.createdAt]),
    ).toEqual([
      ["background", "refused", "2026-11-04T10:00:00.000Z"],
      ["app", "refused", "2026-11-04T10:31:00.000Z"],
      ["background", "refused", "2026-11-04T11:00:01.000Z"],
    ]);
    expect((await monthRow("2026-11")).refusedCalls).toBe(4);
  });
});

describe("past months", () => {
  it("report the cap that applied then, the current month the configured one", async () => {
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "10");
    await (
      await relatedHold(at("2026-10-20T00:00:00Z"))
    ).settle({
      cost: 0.5,
    });
    vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "25");
    const now = new Date("2026-11-04T10:00:00Z");

    expect(await readDataforseoSpend("2026-10", now)).toMatchObject({
      capUsd: 10,
      spentUsd: 0.5,
      remainingUsd: 9.5,
    });
    expect(await readDataforseoSpend("2026-11", now)).toMatchObject({
      capUsd: 25,
    });
  });
});
