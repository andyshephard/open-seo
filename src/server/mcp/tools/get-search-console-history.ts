import { z } from "zod";
import { getSearchConsoleHistory } from "@/server/features/research-history/services/searchConsoleHistory";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";

const inputSchema = {
  projectId: projectIdSchema,
  days: z
    .number()
    .int()
    .min(7)
    .max(730)
    .optional()
    .describe(
      "Days ending on the latest stored day (default 90). History can reach past Google's 16-month limit once OpenSEO has stored it.",
    ),
  dimension: z
    .enum(["query", "page"])
    .optional()
    .describe("Rank top queries (default) or top pages."),
  limit: z.number().int().min(1).max(500).optional(),
  value: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe("Only this exact query or page URL."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

type Row = Awaited<ReturnType<typeof getSearchConsoleHistory>>["rows"][number];

const formatPosition = (value: number | null) =>
  value == null ? null : Math.round(value * 10) / 10;

const COLUMNS: McpTableColumn<Row>[] = [
  { header: "value", value: (row) => row.value },
  { header: "clicks", value: (row) => row.clicks },
  { header: "prev clicks", value: (row) => row.previousClicks },
  { header: "impressions", value: (row) => row.impressions },
  { header: "position", value: (row) => formatPosition(row.position) },
  {
    header: "prev position",
    value: (row) => formatPosition(row.previousPosition),
  },
];

export const getSearchConsoleHistoryTool = {
  name: "get_search_console_history",
  config: {
    title: "Get stored Search Console history",
    description:
      "Returns OpenSEO's daily stored copy of the project's Search Console data: site clicks, impressions, CTR and position per day, plus the top queries or pages over the range compared with the period before. Synced daily for connected properties (finalized days only, ~3 days behind), so it outlives Google's 16-month window. Free and never calls Google; use get_search_console_performance for live or more granular data.",
    inputSchema,
    outputSchema: z
      .object({
        synced: z.boolean(),
        totals: z.array(z.object({ date: z.string() }).passthrough()),
        rows: z.array(z.object({ value: z.string() }).passthrough()),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const history = await getSearchConsoleHistory({
      projectId: args.projectId,
      days: args.days ?? 90,
      dimension: args.dimension ?? "query",
      limit: args.limit ?? 50,
      value: args.value,
    });
    const clicks = history.totals.reduce((total, day) => total + day.clicks, 0);
    const text = history.synced
      ? `Stored Search Console history ${history.from} to ${history.to}: ${clicks} clicks over ${history.totals.length} days.\n${formatMcpTable(history.rows, COLUMNS)}`
      : "No stored Search Console history yet. It syncs daily once Search Console is connected; use get_search_console_performance for live data.";
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/history`,
      ),
      structuredContent: history,
    });
  }),
};
