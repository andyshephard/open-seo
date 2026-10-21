import { beforeEach, expect, it, vi } from "vitest";
import {
  archiveLookup,
  listArchive,
  pruneResearchArchive,
  readArchivedView,
} from "./researchArchive";

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
      put: async (key: string, body: string) => void objects.set(key, body),
      get: async (key: string) => {
        const body = objects.get(key);
        return body == null ? null : { text: async () => body };
      },
      delete: async (keys: string[]) => {
        for (const key of keys) objects.delete(key);
      },
    },
  },
}));
vi.mock("@/db", () => ({ db: testDb.db }));

const customer = {
  organizationId: "organization",
  userId: "user",
  userEmail: "user@example.com",
  projectId: "project",
};
const archive = (fetchedAt: string, rows: number) =>
  archiveLookup(customer, {
    kind: "backlinks_referring_domains",
    target: "openseo.so",
    viewKey: "backlinks:referring-domains-page:abc",
    params: { page: 1 },
    fetchedAt,
    payload: { rows },
  });

beforeEach(async () => {
  objects.clear();
  await testDb.seedProject();
});

it("reopens a view as it stood on a day, from the newest capture by then", async () => {
  await archive("2026-09-01T10:00:00.000Z", 1);
  await archive("2026-10-01T10:00:00.000Z", 2);
  await archive("2026-10-01T10:00:00.000Z", 2);

  expect(
    await readArchivedView(
      customer,
      "backlinks:referring-domains-page:abc",
      "2026-09-15",
    ),
  ).toEqual({ rows: 1 });
  expect(
    await readArchivedView(
      customer,
      "backlinks:referring-domains-page:abc",
      "2026-10-01",
    ),
  ).toEqual({ rows: 2 });
  expect(
    (await listArchive({ projectId: "project", limit: 10 })).entries,
  ).toHaveLength(2);
});

it("reports a view that was not captured on or before the day", async () => {
  await archive("2026-10-01T10:00:00.000Z", 2);

  await expect(
    readArchivedView(
      customer,
      "backlinks:referring-domains-page:abc",
      "2026-09-30",
    ),
  ).rejects.toThrow("not captured");
});

it("deletes expired entries and their stored results", async () => {
  await archive("2025-01-01T10:00:00.000Z", 1);
  await archive("2026-10-01T10:00:00.000Z", 2);

  await pruneResearchArchive(new Date("2026-10-21T00:00:00.000Z"));

  const { entries } = await listArchive({ projectId: "project", limit: 10 });
  expect(entries.map((entry) => entry.fetchedAt)).toEqual([
    "2026-10-01T10:00:00.000Z",
  ]);
  expect(objects.size).toBe(1);
});
