import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleResearchExport } from "./researchExport";

// GET /api/export/dataforseo-spend: the spend cap's month-to-date report, on
// the export API's key (auth itself is covered in researchExport.test.ts).

// The real spend cap module (the shared test setup stubs it).
vi.unmock("@/server/lib/dataforseo/spend-cap");

const { kit, runtime } = await vi.hoisted(async () => {
  const { createSpendTestKit } =
    await import("@/server/lib/dataforseo/spend-cap.testkit");
  return {
    kit: await createSpendTestKit(),
    runtime: { DATABASE_PROVIDER: "d1" } as Record<string, unknown>,
  };
});
vi.mock("cloudflare:workers", () => ({ env: runtime }));
vi.mock("@/db", () => ({ db: kit.db }));
vi.mock("@/db/runBatch", () => ({
  runBatch: kit.runBatch,
  runClaimed: kit.runClaimed,
}));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveLocalNoAuthContext: async () => ({ organizationId: "organization" }),
}));
vi.mock("@/server/mcp/api-key-auth", () => ({
  getApiKey: (request: Request) => request.headers.get("x-api-key"),
  authenticateApiKey: async () => ({
    identity: { organizationId: "organization" },
  }),
}));

const EXPORT_KEY = "k".repeat(32);
const NOW = "2026-10-29T12:00:00.000Z";

function get(path: string, headers: HeadersInit = { "x-api-key": EXPORT_KEY }) {
  return handleResearchExport(
    new Request(`https://seo.example/api/export/${path}`, { headers }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  return () => vi.useRealTimers();
});

describe("DataForSEO spend", () => {
  beforeEach(async () => {
    runtime.AUTH_MODE = "local_noauth";
    runtime.OPENSEO_EXPORT_KEY = EXPORT_KEY;
    await kit.client.executeMultiple(`
      DELETE FROM dataforseo_spend_ledger;
      DELETE FROM dataforseo_spend_months;
      INSERT INTO dataforseo_spend_months
        (month, spent_micros, reserved_micros, live_calls, refused_calls, updated_at)
        VALUES ('2026-10', 3250000, 24000, 3, 1, '${NOW}');
      INSERT INTO dataforseo_spend_ledger
        (month, caller, path, estimated_micros, cost_micros, cost_source, status, created_at)
        VALUES
        ('2026-10', 'mcp:get_keyword_metrics (node)', '/v3/x', 24000, 3000000, 'response', 'settled', '${NOW}'),
        ('2026-10', 'app', '/v3/x', 24000, 250000, 'response', 'settled', '${NOW}'),
        ('2026-10', 'app', '/v3/x', 24000, 0, 'none', 'refused', '${NOW}'),
        ('2026-10', 'cron', '/v3/x', 24000, NULL, NULL, 'pending', '${NOW}');
    `);
  });

  it("reports month-to-date spend against the cap, per caller", async () => {
    const response = await get("dataforseo-spend", { "x-api-key": EXPORT_KEY });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      month: "2026-10",
      capUsd: 25,
      spentUsd: 3.25,
      reservedUsd: 0.024,
      remainingUsd: 21.726,
      capReached: false,
      resetsAt: "2026-11-01T00:00:00.000Z",
      liveCalls: 3,
      refusedCalls: 1,
      callers: [
        {
          caller: "mcp:get_keyword_metrics (node)",
          liveCalls: 1,
          refusalsLogged: 0,
          pendingCalls: 0,
          spentUsd: 3,
        },
        {
          caller: "app",
          liveCalls: 1,
          refusalsLogged: 1,
          pendingCalls: 0,
          spentUsd: 0.25,
        },
        {
          caller: "cron",
          liveCalls: 0,
          refusalsLogged: 0,
          pendingCalls: 1,
          spentUsd: 0,
        },
      ],
    });
  });

  it("reads another month, and rejects a malformed one", async () => {
    const other = await get("dataforseo-spend?month=2026-09", {
      "x-api-key": EXPORT_KEY,
    });
    expect(await other.json()).toMatchObject({
      month: "2026-09",
      spentUsd: 0,
      remainingUsd: 25,
      callers: [],
    });
    const bad = await get("dataforseo-spend?month=2026-13", {
      "x-api-key": EXPORT_KEY,
    });
    expect(bad.status).toBe(400);
  });

  it("uses the same auth as every other export path", async () => {
    expect((await get("dataforseo-spend", {})).status).toBe(401);
    expect((await get("projects", {})).status).toBe(401);
    // An organization's oseo_ API key in the account modes reads it too, as
    // it reads /projects.
    runtime.AUTH_MODE = "password";
    for (const path of ["dataforseo-spend", "projects"])
      expect((await get(path, { "x-api-key": "oseo_k" })).status).toBe(200);
  });
});
