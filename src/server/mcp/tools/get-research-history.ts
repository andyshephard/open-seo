import { z } from "zod";
import { getResearchHistory } from "@/server/features/research-history/services/researchHistory";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import { RESEARCH_HISTORY_MONTHS } from "@/types/schemas/researchHistory";

const inputSchema = {
  projectId: projectIdSchema,
  domains: z
    .array(z.string().min(1).max(255))
    .max(25)
    .optional()
    .describe(
      "Hostnames to compare (e.g. ['example.com']). Defaults to the project's domain plus its saved competitors.",
    ),
  keywords: z
    .array(z.string().min(1).max(200))
    .max(100)
    .optional()
    .describe("Keywords to include. Defaults to the project's saved keywords."),
  months: z
    .union(RESEARCH_HISTORY_MONTHS.map((months) => z.literal(months)))
    .optional()
    .describe("How far back to read: 3, 6 or 12 months. Defaults to 12."),
  includeSubdomains: z
    .boolean()
    .optional()
    .describe(
      "Backlink series to read: subdomain-inclusive (default, matching a bare-domain lookup) or the exact hostname.",
    ),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

type History = Awaited<ReturnType<typeof getResearchHistory>>;

function change(
  first: number | null | undefined,
  last: number | null | undefined,
) {
  if (first == null || last == null) return "?";
  const delta = last - first;
  return `${delta >= 0 ? "+" : ""}${delta}`;
}

function summarize(history: History) {
  const lines = [
    `Research history since ${history.since} (market ${history.market.locationCode}/${history.market.languageCode}).`,
  ];
  for (const entry of history.domains) {
    const firstOverview = entry.overview.at(0);
    const lastOverview = entry.overview.at(-1);
    const firstLinks = entry.backlinks.at(0);
    const lastLinks = entry.backlinks.at(-1);
    lines.push(
      `${entry.domain}${entry.own ? " (own)" : ""}: ${entry.overview.length} overview and ${entry.backlinks.length} backlink snapshots.` +
        (lastOverview
          ? ` Latest ${lastOverview.date}: traffic ${lastOverview.organicTraffic ?? "?"} (${change(firstOverview?.organicTraffic, lastOverview.organicTraffic)}), keywords ${lastOverview.organicKeywords ?? "?"} (${change(firstOverview?.organicKeywords, lastOverview.organicKeywords)}), top 10 ${lastOverview.top10Keywords ?? "?"}.`
          : "") +
        (lastLinks
          ? ` Referring domains ${lastLinks.referringDomains ?? "?"} (${change(firstLinks?.referringDomains, lastLinks.referringDomains)}), backlinks ${lastLinks.backlinks ?? "?"}.`
          : ""),
    );
  }
  const tracked = history.keywords.filter((row) => row.snapshots.length > 0);
  lines.push(
    `${tracked.length} of ${history.keywords.length} keywords have metric snapshots.`,
  );
  if (history.otherCapturedDomains.length > 0)
    lines.push(
      `Other domains with history: ${history.otherCapturedDomains.join(", ")}.`,
    );
  return lines.join("\n");
}

export const getResearchHistoryTool = {
  name: "get_research_history",
  config: {
    title: "Get research history",
    description:
      "Returns stored dated snapshots of domain overview (organic traffic, keywords, top 3/top 10 counts), backlink totals (referring domains, backlinks, rank, new/lost) and keyword metrics (volume, difficulty, CPC) for the project's domain and competitors, oldest first, one point per day. Snapshots are recorded automatically by every domain overview, backlinks and keyword research lookup made in the project, and by the project's scheduled snapshot. Use this to report progress over time instead of storing numbers in reports. Free: reads stored data only, never calls a data provider.",
    inputSchema,
    outputSchema: z
      .object({
        since: z.string(),
        domains: z.array(z.object({ domain: z.string() }).passthrough()),
        keywords: z.array(z.object({ keyword: z.string() }).passthrough()),
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
    const history = await getResearchHistory(context.project, args);
    return mcpResponse({
      text: summarize(history),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/history`,
      ),
      structuredContent: history,
    });
  }),
};
