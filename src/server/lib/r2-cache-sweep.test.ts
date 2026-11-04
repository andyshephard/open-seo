import { sort } from "remeda";
import { beforeEach, expect, it, vi } from "vitest";
import { sweepExpiredCache } from "./r2-cache-sweep";

type StoredObject = {
  key: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
};

// An in-memory bucket with R2's list contract: keys in order, at most `limit`
// a page, an opaque cursor (here, the last key listed).
const { objects, kv } = vi.hoisted(() => ({
  objects: new Map<string, StoredObject>(),
  kv: new Map<string, string>(),
}));
vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      list: async (options: {
        prefix: string;
        cursor?: string;
        limit: number;
      }) => {
        const keys = sort(
          [...objects.keys()].filter(
            (key) =>
              key.startsWith(options.prefix) &&
              (!options.cursor || key > options.cursor),
          ),
          (a, b) => a.localeCompare(b),
        );
        const page = keys.slice(0, options.limit);
        const truncated = keys.length > options.limit;
        return {
          objects: page.map((key) => objects.get(key)),
          truncated,
          cursor: truncated ? page.at(-1) : undefined,
        };
      },
      delete: async (keys: string[]) => {
        for (const key of keys) objects.delete(key);
      },
    },
    KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
  },
}));

const NOW = Date.parse("2026-10-29T03:17:00.000Z");
const DAY = 86_400_000;

function store(key: string, expiresInDays: number | null, ageDays = 1) {
  objects.set(key, {
    key,
    uploaded: new Date(NOW - ageDays * DAY),
    customMetadata:
      expiresInDays == null
        ? undefined
        : { expiresAt: new Date(NOW + expiresInDays * DAY).toISOString() },
  });
}

beforeEach(() => {
  objects.clear();
  kv.clear();
});

it("deletes expired cache entries and keeps fresh ones and the archive", async () => {
  store("dataforseo-cache/keywords:expired", -1);
  store("dataforseo-cache/keywords:fresh", 29);
  store("dataforseo-cache/undated:old", null, 91);
  store("dataforseo-cache/undated:recent", null, 10);
  store("research-archive/project/2025-01-01/entry.json", -400);

  const result = await sweepExpiredCache(NOW);

  expect(result).toEqual({ scanned: 4, deleted: 2, complete: true });
  expect(sort([...objects.keys()], (a, b) => a.localeCompare(b))).toEqual([
    "dataforseo-cache/keywords:fresh",
    "dataforseo-cache/undated:recent",
    "research-archive/project/2025-01-01/entry.json",
  ]);
});

it("judges an unreadable expiresAt by age instead of keeping it forever", async () => {
  for (const [key, ageDays] of [
    ["dataforseo-cache/garbled:old", 91],
    ["dataforseo-cache/garbled:recent", 10],
  ] as const)
    objects.set(key, {
      key,
      uploaded: new Date(NOW - ageDays * DAY),
      customMetadata: { expiresAt: "not a date" },
    });

  const result = await sweepExpiredCache(NOW);

  expect(result.deleted).toBe(1);
  expect([...objects.keys()]).toEqual(["dataforseo-cache/garbled:recent"]);
});

it("stops after a bounded number of listings and resumes there next run", async () => {
  for (let index = 0; index < 20_500; index += 1)
    store(`dataforseo-cache/k:${String(index).padStart(6, "0")}`, -1);

  const first = await sweepExpiredCache(NOW);
  const second = await sweepExpiredCache(NOW);

  expect(first).toEqual({ scanned: 20_000, deleted: 20_000, complete: false });
  expect(second).toEqual({ scanned: 500, deleted: 500, complete: true });
  expect(objects.size).toBe(0);
  expect(kv.size).toBe(0);
});
