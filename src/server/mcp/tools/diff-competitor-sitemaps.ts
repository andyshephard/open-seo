import { z } from "zod";
import {
  diffCompetitorSitemaps,
  MAX_COMPETITOR_DOMAINS,
} from "@/server/features/competitor-sitemaps/services/competitorSitemaps";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  domains: z
    .array(z.string().min(1).max(253))
    .min(1)
    .max(MAX_COMPETITOR_DOMAINS)
    .optional()
    .describe(
      "Competitor domains to check. Defaults to the project context's competitors (up to 10).",
    ),
  sinceDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(7)
    .describe(
      "Window for recentlyModified: URLs whose sitemap lastmod is this recent. Default 7.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const segmentGroups = z.array(
  z.looseObject({
    segment: z.string(),
    count: z.number(),
    sample: z.array(z.string()),
  }),
);

const outputSchema = z.looseObject({
  domainsRequested: z.number(),
  results: z.array(
    z.looseObject({
      domain: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      totalUrls: z.number().optional(),
      firstRun: z.boolean().optional(),
      previousSnapshotAt: z.string().nullable().optional(),
      recentlyModified: z
        .looseObject({
          sinceDays: z.number(),
          count: z.number(),
          byPathSegment: segmentGroups,
        })
        .optional(),
      newUrls: z
        .looseObject({
          count: z.number(),
          byPathSegment: segmentGroups,
          urls: z.array(z.string()),
        })
        .nullable()
        .optional(),
      removedUrls: z
        .looseObject({ count: z.number(), urls: z.array(z.string()) })
        .nullable()
        .optional(),
      refreshedUrls: z
        .looseObject({
          count: z.number(),
          byPathSegment: segmentGroups,
          urls: z.array(z.string()),
        })
        .nullable()
        .optional(),
      notes: z.array(z.string()).optional(),
    }),
  ),
  ...optionalMetaOutputSchema,
});

export const diffCompetitorSitemapsTool = {
  name: "diff_competitor_sitemaps",
  config: {
    title: "Diff competitor sitemaps",
    description:
      "See what competitors published or refreshed: reads each domain's sitemaps (robots.txt Sitemap lines, else /sitemap.xml, following sitemap indexes up to 50,000 URLs), stores a snapshot of every URL with its lastmod, and diffs it against the previous snapshot. Returns new URLs grouped by first path segment (/blog/, /review/ ...), removed URLs, and refreshed URLs (lastmod changed), plus recentlyModified: how many URLs have a lastmod in the last sinceDays, which is useful even on the first run, when there is nothing to diff yet. Run it weekly with the same domains. Uses no credits (no DataForSEO calls); the snapshots are kept in the project's research archive as kind sitemap_snapshot for 13 months. Domains default to the project context's competitors. Sites without a sitemap, or with no lastmod values, give partial answers: check notes.",
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const data = await diffCompetitorSitemaps(args, context.billing);
    const lines = data.results.map((r) => {
      if (!r.ok) return `${r.domain}: ${r.error}`;
      const diff = r.firstRun
        ? "first snapshot, no diff yet"
        : `${r.newUrls?.count ?? 0} new, ${r.refreshedUrls?.count ?? 0} refreshed, ${r.removedUrls?.count ?? "?"} removed since ${r.previousSnapshotAt}`;
      return `${r.domain}: ${r.totalUrls} URLs; ${r.recentlyModified.count} modified in the last ${r.recentlyModified.sinceDays} days; ${diff}.`;
    });
    return mcpResponse({
      text:
        data.results.length === 0
          ? "No domains to check: pass domains, or add competitors with update_project_context."
          : lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/history`,
      ),
      structuredContent: data,
    });
  }),
};
