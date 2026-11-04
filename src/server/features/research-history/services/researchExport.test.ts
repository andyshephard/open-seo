import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  domainBacklinkSnapshots,
  domainSnapshots,
  exportDeletions,
  gscDailyRows,
  gscDailyTotals,
  keywordMetricSnapshots,
  researchArchiveEntries,
} from "@/db/schema";
import { ResearchHistoryRepository } from "../repositories/ResearchHistoryRepository";
import { handleResearchExport } from "./researchExport";

const { testDb, runtime, verifyApiKey, objects } = await vi.hoisted(
  async () => {
    const { createAiVisibilityTestDb } =
      await import("@/server/features/ai-visibility/aiVisibilityTestDb");
    const stored = new Map<string, string>();
    return {
      testDb: await createAiVisibilityTestDb(),
      // The mocked worker env; tests set AUTH_MODE and OPENSEO_EXPORT_KEY.
      runtime: {
        DATABASE_PROVIDER: "d1",
        R2: {
          get: async (key: string) => {
            const body = stored.get(key);
            return body == null ? null : { body };
          },
        },
      } as Record<string, unknown>,
      verifyApiKey: vi.fn(),
      objects: stored,
    };
  },
);
vi.mock("cloudflare:workers", () => ({ env: runtime }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({
  executeInBatches: async <T>(
    items: T[],
    build: (tx: typeof testDb.db, item: T) => Promise<unknown>,
  ) => {
    for (const item of items) await build(testDb.db, item);
  },
}));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { verifyApiKey } }),
  getHostedBaseUrl: () => "https://app.openseo.so",
}));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: {
    getHostedUser: async () => ({ email: "person@example.com" }),
    getMembership: async () => ({ role: "owner" }),
  },
}));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveLocalNoAuthContext: async () => ({ organizationId: "organization" }),
}));

const EXPORT_KEY = "k".repeat(32);
const NOW = "2026-10-29T12:00:00.000Z";
const EARLIER = "2026-10-29T11:00:00.000Z";
const market = { locationCode: 2826, languageCode: "en" };

const boundTo = (organizationId: string) => ({
  valid: true,
  key: { referenceId: "user-1", metadata: { organizationId } },
});

function get(path: string, headers: HeadersInit = { "x-api-key": "oseo_k" }) {
  return handleResearchExport(
    new Request(`https://app.openseo.so/api/export/${path}`, { headers }),
  );
}

async function lines(response: Response) {
  const text = await response.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}

const keywordRow = (keyword: string, writtenAt = EARLIER) => ({
  projectId: "project",
  keyword,
  ...market,
  capturedOn: "2026-10-29",
  searchVolume: 10,
  writtenAt,
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  runtime.AUTH_MODE = "password";
  runtime.OPENSEO_EXPORT_KEY = undefined;
  verifyApiKey.mockResolvedValue(boundTo("organization"));
  objects.clear();
  await testDb.seedProject();
  await testDb.client.executeMultiple(`
    INSERT INTO organization (id, name, slug, created_at)
      VALUES ('other-org', 'Other', 'other-org', 0);
    INSERT INTO projects (id, organization_id, name, domain)
      VALUES ('other-project', 'other-org', 'Other', 'other.example');
  `);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auth", () => {
  it.each([
    ["password mode without a key", "password", undefined, {}, 401],
    [
      "local_noauth with the export key unset",
      "local_noauth",
      undefined,
      { "x-api-key": EXPORT_KEY },
      404,
    ],
    ["local_noauth without a key", "local_noauth", EXPORT_KEY, {}, 401],
    [
      "local_noauth with a wrong key",
      "local_noauth",
      EXPORT_KEY,
      { "x-api-key": "x".repeat(32) },
      401,
    ],
    [
      "local_noauth with the key as a Bearer token",
      "local_noauth",
      EXPORT_KEY,
      { Authorization: `Bearer ${EXPORT_KEY}` },
      401,
    ],
    ["everyapp mode", "everyapp", EXPORT_KEY, { "x-api-key": EXPORT_KEY }, 404],
  ])("refuses %s", async (_label, mode, exportKey, headers, status) => {
    runtime.AUTH_MODE = mode;
    runtime.OPENSEO_EXPORT_KEY = exportKey;
    const response = await get("projects", headers);
    expect(response.status).toBe(status);
  });

  it("refuses an API key the plugin rejects", async () => {
    verifyApiKey.mockResolvedValue({ valid: false, error: null, key: null });
    expect((await get("projects")).status).toBe(401);
  });

  it("serves local_noauth the one workspace, given the export key", async () => {
    runtime.AUTH_MODE = "local_noauth";
    runtime.OPENSEO_EXPORT_KEY = EXPORT_KEY;
    const response = await get("projects", { "x-api-key": EXPORT_KEY });
    expect((await lines(response)).map((row) => row.id)).toEqual(["project"]);
  });
});

describe("organization scoping", () => {
  it("lists only the key's organization's projects", async () => {
    expect((await lines(await get("projects"))).map((row) => row.id)).toEqual([
      "project",
    ]);
  });

  it("answers 404 for another organization's project and its archive", async () => {
    await testDb.db.insert(researchArchiveEntries).values({
      id: "entry",
      projectId: "other-project",
      kind: "domain_overview",
      target: "other.example",
      viewKey: "view",
      params: "{}",
      origin: "app",
      fetchedAt: EARLIER,
      r2Key: "research-archive/other-project/entry.json",
      sizeBytes: 2,
    });
    objects.set("research-archive/other-project/entry.json", "{}");

    const page = await get("domain_snapshots?projectId=other-project");
    const payload = await get(
      "research_archive_entries/entry/payload?projectId=other-project",
    );

    expect(page.status).toBe(404);
    expect(payload.status).toBe(404);
  });
});

describe("cursor", () => {
  it("pages through rows sharing one written_at without skipping or repeating", async () => {
    await testDb.db
      .insert(keywordMetricSnapshots)
      .values(["a", "b", "c", "d", "e"].map((keyword) => keywordRow(keyword)));

    const seen: unknown[] = [];
    const hasMore: string[] = [];
    let since = "";
    for (let page = 0; page < 3; page += 1) {
      const response = await get(
        `keyword_metric_snapshots?projectId=project&limit=2${since ? `&since=${since}` : ""}`,
      );
      seen.push(...(await lines(response)).map((row) => row.keyword));
      hasMore.push(response.headers.get("X-Has-More") ?? "");
      since = response.headers.get("X-Next-Cursor") ?? "";
    }

    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(hasMore).toEqual(["true", "true", "false"]);
    // An empty page keeps the cursor, so it can always be stored.
    const empty = await get(
      `keyword_metric_snapshots?projectId=project&since=${since}`,
    );
    expect(await lines(empty)).toEqual([]);
    expect(empty.headers.get("X-Next-Cursor")).toBe(since);
  });

  it("hands out a same-day replace again, once it has settled", async () => {
    await testDb.db.insert(keywordMetricSnapshots).values(keywordRow("a"));
    const first = await get("keyword_metric_snapshots?projectId=project");
    const since = first.headers.get("X-Next-Cursor") ?? "";

    await ResearchHistoryRepository.upsertKeywordSnapshots([
      { ...keywordRow("a"), searchVolume: 20, capturedAt: NOW },
    ]);
    const unsettled = await get(
      `keyword_metric_snapshots?projectId=project&since=${since}`,
    );
    vi.setSystemTime(new Date(Date.parse(NOW) + 5 * 60_000));
    const settled = await get(
      `keyword_metric_snapshots?projectId=project&since=${since}`,
    );

    expect(await lines(unsettled)).toEqual([]);
    expect((await lines(settled)).map((row) => row.search_volume)).toEqual([
      20,
    ]);
  });

  it("rejects a cursor from a table with a different key type", async () => {
    await testDb.db.insert(keywordMetricSnapshots).values(keywordRow("a"));
    const since =
      (await get("keyword_metric_snapshots?projectId=project")).headers.get(
        "X-Next-Cursor",
      ) ?? "";
    const response = await get(
      `gsc_daily_totals?projectId=project&since=${since}`,
    );
    expect(response.status).toBe(400);
  });
});

describe("tables", () => {
  beforeEach(async () => {
    const base = { projectId: "project", writtenAt: EARLIER };
    await testDb.db.insert(domainSnapshots).values({
      ...base,
      ...market,
      domain: "openseo.so",
      capturedOn: "2026-10-29",
      organicTraffic: 100,
    });
    await testDb.db.insert(domainBacklinkSnapshots).values({
      ...base,
      domain: "openseo.so",
      includeSubdomains: true,
      capturedOn: "2026-10-29",
      backlinks: 50,
    });
    await testDb.db.insert(keywordMetricSnapshots).values(keywordRow("seo"));
    await testDb.db.insert(gscDailyTotals).values({
      ...base,
      date: "2026-10-27",
      clicks: 3,
      impressions: 40,
      ctr: 0.075,
      position: 8.2,
    });
    await testDb.db.insert(gscDailyRows).values({
      ...base,
      date: "2026-10-27",
      dimension: "query",
      value: "open seo",
      clicks: 2,
      impressions: 10,
      ctr: 0.2,
      position: 3,
    });
    await testDb.db.insert(researchArchiveEntries).values({
      ...base,
      id: "entry",
      kind: "domain_overview",
      target: "openseo.so",
      viewKey: "view",
      params: '{"page":1}',
      origin: "app",
      fetchedAt: "2026-10-01T00:00:00.000Z",
      r2Key: "research-archive/project/entry.json",
      sizeBytes: 13,
    });
    objects.set("research-archive/project/entry.json", '{"rows":[1,2]}');
  });

  it.each([
    ["domain_snapshots", { organic_traffic: 100 }],
    ["domain_backlink_snapshots", { backlinks: 50, include_subdomains: true }],
    ["keyword_metric_snapshots", { keyword: "seo" }],
    ["gsc_daily_totals", { date: "2026-10-27", clicks: 3 }],
    ["gsc_daily_rows", { value: "open seo", dimension: "query" }],
    ["research_archive_entries", { id: "entry", params: '{"page":1}' }],
  ])("exports %s as NDJSON with SQL column names", async (table, fields) => {
    const response = await get(`${table}?projectId=project`);

    expect(response.headers.get("Content-Type")).toContain(
      "application/x-ndjson",
    );
    const rows = await lines(response);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ...fields,
      project_id: "project",
      written_at: EARLIER,
    });
  });

  it("links archive metadata to its payload and keeps the storage path out", async () => {
    const [entry] = await lines(
      await get("research_archive_entries?projectId=project"),
    );
    expect(entry).not.toHaveProperty("r2_key");

    const payload = await get(String(entry.payload_path).slice(12));

    expect(await payload.json()).toEqual({ rows: [1, 2] });
  });
});

describe("deletions", () => {
  it("lists a project's deletes with their scope, paged like the tables", async () => {
    await testDb.db.insert(exportDeletions).values([
      {
        projectId: "project",
        tableName: "gsc_daily_rows",
        scope: '{"all":true}',
        writtenAt: EARLIER,
      },
      {
        projectId: "project",
        tableName: "research_archive_entries",
        scope: '{"ids":["entry"]}',
        writtenAt: EARLIER,
      },
      {
        projectId: "other-project",
        tableName: "gsc_daily_rows",
        scope: '{"all":true}',
        writtenAt: EARLIER,
      },
      // Not settled yet.
      {
        projectId: "project",
        tableName: "domain_snapshots",
        scope: '{"before":"2025-09-29"}',
        writtenAt: NOW,
      },
    ]);

    const first = await get("deletions?projectId=project&limit=1");
    const rest = await get(
      `deletions?projectId=project&since=${first.headers.get("X-Next-Cursor")}`,
    );

    expect(await lines(first)).toEqual([
      expect.objectContaining({
        project_id: "project",
        table_name: "gsc_daily_rows",
        scope: { all: true },
        written_at: EARLIER,
      }),
    ]);
    expect(first.headers.get("X-Has-More")).toBe("true");
    expect(await lines(rest)).toEqual([
      expect.objectContaining({
        table_name: "research_archive_entries",
        scope: { ids: ["entry"] },
      }),
    ]);
    expect(rest.headers.get("X-Has-More")).toBe("false");
  });

  it("answers 404 for another organization's project", async () => {
    expect((await get("deletions?projectId=other-project")).status).toBe(404);
  });
});
