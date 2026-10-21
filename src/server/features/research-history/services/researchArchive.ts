import { env } from "cloudflare:workers";
import { unique } from "remeda";
import { parseResearchTarget } from "@/shared/researchScope";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AppError } from "@/server/lib/errors";
import type { ResearchArchiveKind } from "@/types/schemas/researchHistory";
import { ResearchArchiveRepository as repo } from "../repositories/ResearchArchiveRepository";

// Every fresh research result fetched inside a project is archived: the JSON
// result goes to R2 under the project's prefix (deleted with the project's
// storage on erasure), and a row indexes it by the live view's cache key. A
// failed archive write is logged, never surfaced: the lookup it records has
// already succeeded and been paid for.

const ARCHIVE_PREFIX = "research-archive/";
const RETENTION_MONTHS = 13;
const PRUNE_BATCH = 200;

function archiveProjectPrefix(projectId: string) {
  return `${ARCHIVE_PREFIX}${projectId}/`;
}

// Lookup inputs minus what the entry records elsewhere (project, target,
// market): what is left is the view (page, sort, filters, scope...).
const NON_VIEW_FIELDS = [
  "projectId",
  "organizationId",
  "domain",
  "target",
  "keyword",
  "keywords",
  "locationCode",
  "languageCode",
  "asOf",
  "refresh",
  "maxAgeDays",
] as const;

export function archiveParams(input: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) =>
        value !== undefined &&
        !(NON_VIEW_FIELDS as readonly string[]).includes(key),
    ),
  );
}

async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Returns true when this call stored a new entry. */
export async function archiveLookup(
  customer: BillingCustomerContext,
  entry: {
    kind: ResearchArchiveKind;
    target: string;
    viewKey: string;
    params: Record<string, unknown>;
    market?: { locationCode: number; languageCode: string };
    fetchedAt: string;
    payload: unknown;
  },
) {
  const projectId = customer.projectId;
  if (!projectId) return false;
  try {
    const id = (
      await sha256Hex(`${projectId}|${entry.viewKey}|${entry.fetchedAt}`)
    ).slice(0, 32);
    // Cache hits re-record the same fetch; keep that to one cheap read.
    if (await repo.getEntry(projectId, id)) return false;
    const r2Key = `${archiveProjectPrefix(projectId)}${entry.fetchedAt.slice(0, 10)}/${id}.json`;
    const body = JSON.stringify(entry.payload);
    await env.R2.put(r2Key, body, {
      httpMetadata: { contentType: "application/json" },
    });
    await repo.insertEntry({
      id,
      projectId,
      kind: entry.kind,
      target: entry.target,
      viewKey: entry.viewKey,
      params: JSON.stringify(entry.params),
      locationCode: entry.market?.locationCode ?? null,
      languageCode: entry.market?.languageCode ?? null,
      origin: customer.origin ?? "app",
      fetchedAt: entry.fetchedAt,
      r2Key,
      sizeBytes: new TextEncoder().encode(body).byteLength,
    });
    return true;
  } catch (error) {
    console.error(`research-archive.${entry.kind} failed:`, error);
    return false;
  }
}

async function readPayload(r2Key: string): Promise<unknown> {
  const object = await env.R2.get(r2Key);
  if (!object) return null;
  return JSON.parse(await object.text()) as unknown;
}

/**
 * The archived result of a live view as it stood on `asOf` (YYYY-MM-DD): the
 * newest capture fetched on or before that day. Throws NOT_FOUND when the view
 * was never captured by then.
 */
export async function readArchivedView(
  customer: BillingCustomerContext,
  viewKey: string,
  asOf: string,
): Promise<unknown> {
  const projectId = customer.projectId;
  const entry = projectId
    ? await repo.findViewAt(projectId, viewKey, `${asOf}T23:59:59.999Z`)
    : null;
  const payload = entry ? await readPayload(entry.r2Key) : null;
  if (!payload)
    throw new AppError(
      "NOT_FOUND",
      "This view was not captured on or before that date.",
    );
  return payload;
}

function toSummary(row: Awaited<ReturnType<typeof repo.listEntries>>[number]) {
  return {
    id: row.id,
    kind: row.kind,
    target: row.target,
    // The view parameters as stored (JSON), since they are display-only.
    params: row.params,
    locationCode: row.locationCode,
    languageCode: row.languageCode,
    origin: row.origin,
    fetchedAt: row.fetchedAt,
    sizeBytes: row.sizeBytes,
  };
}

/**
 * The spellings a target may be archived under: as typed, lowercased (keyword
 * research), and the normalized display and hostname of a domain or URL.
 */
function targetCandidates(target: string) {
  const parsed = parseResearchTarget(target);
  return unique([
    target,
    target.toLowerCase(),
    ...(parsed.ok ? [parsed.target.display, parsed.target.hostname] : []),
  ]);
}

export async function listArchive(input: {
  projectId: string;
  kinds?: string[];
  target?: string;
  from?: string;
  before?: string;
  limit: number;
}) {
  const { target, ...rest } = input;
  const rows = await repo.listEntries({
    ...rest,
    targets: target ? targetCandidates(target.trim()) : undefined,
  });
  return {
    entries: rows.map(toSummary),
    // Pass as `before` to read the next page.
    nextBefore: rows.length === input.limit ? rows.at(-1)?.fetchedAt : null,
  };
}

export async function getArchiveEntry(projectId: string, id: string) {
  const row = await repo.getEntry(projectId, id);
  if (!row) throw new AppError("NOT_FOUND", "Archived lookup not found.");
  return { ...toSummary(row), result: await readPayload(row.r2Key) };
}

/** Retention: deletes a batch of entries older than 13 months, R2 first. */
export async function pruneResearchArchive(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  const expired = await repo.listExpired(cutoff.toISOString(), PRUNE_BATCH);
  if (expired.length === 0) return 0;
  await env.R2.delete(expired.map((row) => row.r2Key));
  await repo.deleteEntries(expired.map((row) => row.id));
  return expired.length;
}

/** GDPR/project erasure: every archived object under the project's prefix. */
export async function deleteProjectArchiveObjects(
  bucket: R2Bucket,
  projectId: string,
) {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list({
      prefix: archiveProjectPrefix(projectId),
      cursor,
    });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    deleted += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

export async function setReportSources(input: {
  projectId: string;
  reportId: string;
  entryIds: string[];
}) {
  return repo.setReportSources(input);
}

/** The archived results a report was built from, newest first. */
export async function listReportSources(projectId: string, reportId: string) {
  return (await repo.listReportSources(projectId, reportId)).map(({ entry }) =>
    toSummary(entry),
  );
}
