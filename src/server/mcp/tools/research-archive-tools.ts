import { z } from "zod";
import {
  getArchiveEntry,
  listArchive,
} from "@/server/features/research-history/services/researchArchive";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { RESEARCH_ARCHIVE_KINDS } from "@/types/schemas/researchHistory";

const KIND_DESCRIPTION =
  "domain_overview, domain_keywords (ranked keywords table), domain_pages (top pages), domain_keyword_suggestions, ranked_keywords (get_ranked_keywords), backlinks_overview, backlinks_rows, backlinks_referring_domains, backlinks_top_pages, keyword_research, keyword_metrics, serp_analysis, rank_check_serp (the full Google results page of each rank tracking check).";

const listInputSchema = {
  projectId: projectIdSchema,
  kinds: z
    .array(z.enum(RESEARCH_ARCHIVE_KINDS))
    .max(20)
    .optional()
    .describe(`Result kinds to include; omit for all. ${KIND_DESCRIPTION}`),
  target: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      "Exact domain, URL or keyword as archived (e.g. 'example.com', or the tracked keyword for rank_check_serp).",
    ),
  from: z
    .string()
    .max(40)
    .optional()
    .describe("Only lookups fetched at or after this ISO date or timestamp."),
  before: z
    .string()
    .max(40)
    .optional()
    .describe(
      "Only lookups fetched before this ISO timestamp; pass nextBefore from the previous page to page back.",
    ),
  limit: z.number().int().min(1).max(200).optional(),
} as const;

type ListArgs = z.infer<z.ZodObject<typeof listInputSchema>>;

export const listResearchArchiveTool = {
  name: "list_research_archive",
  config: {
    title: "List archived research lookups",
    description:
      "Lists the project's archived research results, newest first: every fresh Domain Overview, Backlinks, Keyword Research, SERP and get_ranked_keywords/get_keyword_metrics lookup made in the app, by an agent or by a schedule, plus the full results page of every rank tracking check. Each entry has an id, kind, target, view parameters (page, sort, filters, device), market, origin and fetch time. Read one with get_research_archive_entry. Free: reads stored data only. Use it to compare a domain's referring domains, ranked keywords or SERP competitors between dates.",
    inputSchema: listInputSchema,
    outputSchema: z
      .object({
        entries: z.array(z.object({ id: z.string() }).passthrough()),
        nextBefore: z.string().nullable().optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ListArgs, context) => {
    const result = await listArchive({
      projectId: args.projectId,
      kinds: args.kinds,
      target: args.target,
      from: args.from,
      before: args.before,
      limit: args.limit ?? 50,
    });
    const lines = result.entries.map(
      (entry) =>
        `${entry.fetchedAt} · ${entry.kind} · ${entry.target}${entry.params === "{}" ? "" : ` · ${entry.params}`} · via ${entry.origin} · id ${entry.id}`,
    );
    return mcpResponse({
      text:
        lines.length === 0
          ? "No archived lookups match."
          : `${lines.length} archived lookups${result.nextBefore ? ` (more: before=${result.nextBefore})` : ""}:\n${lines.join("\n")}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/history`,
      ),
      structuredContent: result,
    });
  }),
};

const getInputSchema = {
  projectId: projectIdSchema,
  id: z
    .string()
    .min(1)
    .max(64)
    .describe("Entry id from list_research_archive."),
} as const;

type GetArgs = z.infer<z.ZodObject<typeof getInputSchema>>;

// The text copy stays small; the full result is in structuredContent.
const TEXT_PREVIEW_CHARS = 20_000;

export const getResearchArchiveEntryTool = {
  name: "get_research_archive_entry",
  config: {
    title: "Get archived research result",
    description:
      "Returns one archived research result exactly as it was fetched (the same rows the app showed: ranked keywords, referring domains, backlinks, top pages, keyword ideas, SERP items...), with its kind, target, view parameters and fetch time. Free: reads stored data only.",
    inputSchema: getInputSchema,
    outputSchema: z
      .object({
        id: z.string(),
        kind: z.string(),
        target: z.string(),
        fetchedAt: z.string(),
        result: z.unknown(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetArgs, context) => {
    const entry = await getArchiveEntry(args.projectId, args.id);
    const json = JSON.stringify(entry.result);
    return mcpResponse({
      text: `${entry.kind} for ${entry.target}, fetched ${entry.fetchedAt} via ${entry.origin}.\n${json.length > TEXT_PREVIEW_CHARS ? `${json.slice(0, TEXT_PREVIEW_CHARS)}… (truncated; full result in structured content)` : json}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/history`,
      ),
      structuredContent: entry,
    });
  }),
};
