import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { sort } from "remeda";
// The SQLite tables directly: @/db/schema reads the worker env, which is not
// mocked yet while vi.hoisted runs.
import {
  dataforseoSpendLedger,
  dataforseoSpendMonths,
} from "@/db/dataforseo-spend.schema";

/**
 * In-memory SQLite with every production migration applied, a minimal R2 for
 * the provider cache, and a swappable DataForSEO fetch, for the spend cap
 * tests. Create it inside `vi.hoisted` and serve it from mocked `@/db`,
 * `cloudflare:workers` and `@/server/lib/provider-access`.
 */
export async function createSpendTestKit() {
  const client = createClient({ url: "file::memory:" });
  const migrations = sort(
    readdirSync("drizzle/sqlite").filter((file) => file.endsWith(".sql")),
    (a, b) => a.localeCompare(b),
  );
  for (const file of migrations)
    await client.executeMultiple(
      readFileSync(`drizzle/sqlite/${file}`, "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    );
  const db = drizzle(client);

  const objects = new Map<
    string,
    { body: string; customMetadata: Record<string, string>; uploaded: Date }
  >();
  const bucket = {
    get: async (key: string) => {
      const object = objects.get(key);
      return object ? { ...object, text: async () => object.body } : null;
    },
    put: async (
      key: string,
      body: string,
      options: { customMetadata?: Record<string, string> },
    ) => {
      objects.set(key, {
        body,
        customMetadata: options.customMetadata ?? {},
        uploaded: new Date(),
      });
    },
  };

  const upstream: { fetch: null | ((url: string) => Promise<Response>) } = {
    fetch: null,
  };
  /** What getDataforseoFetch hands core.ts: the test's fetch, or a throw. */
  const dataforseoFetch = async (input: RequestInfo) => {
    if (!upstream.fetch) throw new Error("no DataForSEO request expected");
    return upstream.fetch(typeof input === "string" ? input : input.url);
  };

  // libsql's batch runs as one transaction, as D1's does. Test-only: app code
  // batches through src/db/runBatch.ts (schema-parity.test.ts).
  const atomicBatch = db.batch.bind(db);

  /** runBatch on D1: one atomic batch. */
  const runBatch = async (
    build: (tx: typeof db) => readonly Promise<unknown>[],
  ) => {
    const statements = build(db);
    if (statements.length === 0) return;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- drizzle query builders are batch items; length checked above
    await atomicBatch(statements as unknown as Parameters<typeof db.batch>[0]);
  };

  /** runClaimed on D1, as runBatch.ts runs it: guarded apply, then claim. */
  const runClaimed = async (steps: {
    claim: (tx: typeof db) => Promise<unknown[]>;
    applyWhileUnclaimed: (tx: typeof db) => Promise<unknown>;
  }) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- drizzle query builders are batch items
    const batch = [
      steps.applyWhileUnclaimed(db),
      steps.claim(db),
    ] as unknown as Parameters<typeof db.batch>[0];
    const results: readonly unknown[] = await atomicBatch(batch);
    const claimed = results[1];
    return Array.isArray(claimed) && claimed.length > 0;
  };

  return {
    client,
    db,
    runBatch,
    runClaimed,
    bucket,
    upstream,
    dataforseoFetch,
    reset: async () => {
      await client.executeMultiple(`
        DELETE FROM dataforseo_spend_ledger;
        DELETE FROM dataforseo_spend_months;
      `);
      objects.clear();
      upstream.fetch = null;
    },
    monthRow: async (month: string) => {
      const [row] = await db
        .select()
        .from(dataforseoSpendMonths)
        .where(eq(dataforseoSpendMonths.month, month));
      return row;
    },
    ledger: () =>
      db.select().from(dataforseoSpendLedger).orderBy(dataforseoSpendLedger.id),
  };
}

// Labs related_keywords at limit 100: $0.012 + 100 x $0.00012 = $0.024.
export const RELATED = "/v3/dataforseo_labs/google/related_keywords/live";
export const relatedTask = (keyword = "seo") => [{ keyword, limit: 100 }];

export const at = (iso: string) => () => new Date(iso);

export function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}
