import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  EXPORT_TABLES,
  ResearchExportRepository as repo,
  type ExportCursor,
  type ExportTableName,
} from "../repositories/ResearchExportRepository";
import { ResearchArchiveRepository } from "../repositories/ResearchArchiveRepository";
import { EXPORT_PATH_PREFIX } from "@/shared/research-export";
import { authenticateExportRequest } from "./exportAuth";
import { readDataforseoSpend } from "@/server/lib/dataforseo/spend-ledger";

// Read-only, incremental export of the research history tables, for loading
// into a warehouse. OpenSEO only stores the data; analysis happens downstream.
//
//   GET /api/export/projects
//   GET /api/export/{table}?projectId=&since=&limit=   (and table "deletions")
//   GET /api/export/research_archive_entries/{id}/payload?projectId=
//   GET /api/export/dataforseo-spend[?month=YYYY-MM]   (JSON, see below)
//
// Table pages are NDJSON, one row per line with the table's SQL column names.
// Rows come in (written_at, key) order; `X-Next-Cursor` is the position after
// the last row, passed back as `since` to read on. Every row written since is
// returned exactly once per write: a same-day replace stamps a new written_at
// and comes back as a newer copy of the row (dedupe on the table's natural
// key, keeping the latest written_at). Rows appear SETTLE_MS after their
// write, so a write still in flight when a page is read cannot land behind
// the cursor. Deletes from these tables (a Google disconnect, retention) are
// listed in the `deletions` table, paged the same way; a deleted project
// instead drops out of /projects.

const SETTLE_MS = 5 * 60_000;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const STREAM_CHUNK_ROWS = 200;

const tableNameSchema = z.enum(
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.keys of a literal object
  Object.keys(EXPORT_TABLES) as [ExportTableName, ...ExportTableName[]],
);

const pageParamsSchema = z.object({
  projectId: z.string().min(1),
  since: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const cursorSchema = z.tuple([
  z.iso.datetime(),
  z.union([z.string(), z.int()]),
]);

function jsonError(status: number, error: string, description: string) {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function encodeCursor(cursor: ExportCursor) {
  return Buffer.from(JSON.stringify([cursor.writtenAt, cursor.key])).toString(
    "base64url",
  );
}

function decodeCursor(
  value: string,
  keyType: "number" | "string",
): ExportCursor | null {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (!parsed.success || typeof parsed.data[1] !== keyType) return null;
    return { writtenAt: parsed.data[0], key: parsed.data[1] };
  } catch {
    return null;
  }
}

/** Serializes rows to NDJSON a chunk at a time instead of one large string. */
function ndjsonResponse(rows: unknown[], headers: Record<string, string>) {
  const encoder = new TextEncoder();
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = rows.slice(offset, offset + STREAM_CHUNK_ROWS);
      offset += STREAM_CHUNK_ROWS;
      if (chunk.length === 0) {
        controller.close();
        return;
      }
      controller.enqueue(
        encoder.encode(chunk.map((row) => `${JSON.stringify(row)}\n`).join("")),
      );
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function archivePayloadPath(id: string, projectId: string) {
  return `${EXPORT_PATH_PREFIX}research_archive_entries/${id}/payload?projectId=${encodeURIComponent(projectId)}`;
}

/** A row as exported: archive entries link their payload, scopes are JSON. */
function exportRow(
  table: ExportTableName,
  row: Record<string, unknown>,
  projectId: string,
) {
  if (table === "research_archive_entries" && typeof row.id === "string")
    return { ...row, payload_path: archivePayloadPath(row.id, projectId) };
  if (table === "deletions" && typeof row.scope === "string")
    return { ...row, scope: JSON.parse(row.scope) as unknown };
  return row;
}

async function exportTablePage(
  table: ExportTableName,
  url: URL,
  organizationId: string,
) {
  const params = pageParamsSchema.safeParse(
    Object.fromEntries(url.searchParams),
  );
  if (!params.success)
    return jsonError(
      400,
      "invalid_request",
      `projectId is required; limit is 1-${MAX_LIMIT}.`,
    );
  const { projectId, since, limit } = params.data;
  const after = since
    ? decodeCursor(since, EXPORT_TABLES[table].keyType)
    : null;
  if (since && !after)
    return jsonError(
      400,
      "invalid_cursor",
      "since must be an X-Next-Cursor value from this table.",
    );
  if (!(await repo.projectInOrganization(projectId, organizationId)))
    return jsonError(404, "not_found", "Project not found.");

  // One extra row says whether another page follows.
  const page = await repo.readPage({
    table,
    projectId,
    after,
    settledBefore: new Date(Date.now() - SETTLE_MS).toISOString(),
    limit: limit + 1,
  });
  const hasMore = page.length > limit;
  const rows = page.slice(0, limit);
  const last = rows.at(-1)?.cursor;
  return ndjsonResponse(
    rows.map(({ row }) => exportRow(table, row, projectId)),
    {
      // Unchanged when the page is empty, so it can always be stored.
      "X-Next-Cursor": last ? encodeCursor(last) : (since ?? ""),
      "X-Has-More": String(hasMore),
    },
  );
}

async function exportArchivePayload(
  entryId: string,
  url: URL,
  organizationId: string,
) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId)
    return jsonError(400, "invalid_request", "projectId is required.");
  const entry = (await repo.projectInOrganization(projectId, organizationId))
    ? await ResearchArchiveRepository.getEntry(projectId, entryId)
    : null;
  const object = entry ? await env.R2.get(entry.r2Key) : null;
  if (!object) return jsonError(404, "not_found", "Archive entry not found.");
  // Streamed straight from storage: a payload can be several megabytes.
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

// The deployment's DataForSEO spend against its monthly cap (spend-cap.ts):
// month-to-date spend, cap, remaining and per-caller counts. Authenticated
// exactly as every other export path (authenticateExportRequest in
// handleResearchExport). The figures are deployment-wide, not per
// organization: in the account modes any organization's export key reads them.
async function exportDataforseoSpend(url: URL) {
  const month = url.searchParams.get("month") ?? undefined;
  if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    return jsonError(400, "invalid_request", "month must be YYYY-MM.");
  return new Response(JSON.stringify(await readDataforseoSpend(month)), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleResearchExport(request: Request) {
  if (request.method !== "GET")
    return jsonError(405, "method_not_allowed", "Use GET.");
  const auth = await authenticateExportRequest(request);
  if ("response" in auth) return auth.response;
  const { organizationId } = auth;

  try {
    const url = new URL(request.url);
    // Table names and archive ids are plain ASCII, so no decoding.
    const segments = url.pathname.slice(EXPORT_PATH_PREFIX.length).split("/");
    if (segments.length === 1 && segments[0] === "dataforseo-spend")
      return await exportDataforseoSpend(url);
    if (segments.length === 1 && segments[0] === "projects")
      return ndjsonResponse(await repo.listProjects(organizationId), {});
    const table = tableNameSchema.safeParse(segments[0]);
    if (table.success && segments.length === 1)
      return await exportTablePage(table.data, url, organizationId);
    if (
      table.data === "research_archive_entries" &&
      segments.length === 3 &&
      segments[2] === "payload"
    )
      return await exportArchivePayload(segments[1], url, organizationId);
    return jsonError(404, "not_found", "Unknown export path.");
  } catch (error) {
    console.error("[research-export] 500:", error);
    return jsonError(500, "internal_error", "Export failed.");
  }
}
