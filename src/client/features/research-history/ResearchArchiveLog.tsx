import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { listResearchArchive } from "@/serverFunctions/researchHistory";
import { ArchiveEntrySheet } from "./ArchiveEntrySheet";
import type { ResearchArchiveKind } from "@/types/schemas/researchHistory";

type Entry = Awaited<ReturnType<typeof listResearchArchive>>["entries"][number];

const SECTIONS = {
  all: { label: "All sections", kinds: undefined },
  domain: {
    label: "Domain Overview",
    kinds: ["domain_overview", "domain_keywords", "domain_pages"],
  },
  backlinks: {
    label: "Backlinks",
    kinds: [
      "backlinks_overview",
      "backlinks_rows",
      "backlinks_referring_domains",
      "backlinks_top_pages",
    ],
  },
  keywords: {
    label: "Keyword Research",
    kinds: ["keyword_research", "serp_analysis"],
  },
  rank: { label: "Rank Tracking", kinds: ["rank_check_serp"] },
  ai: {
    label: "AI search",
    kinds: ["brand_lookup", "prompt_research", "prompt_explorer"],
  },
  agent: {
    label: "Agent-only lookups",
    kinds: [
      "ranked_keywords",
      "keyword_metrics",
      "domain_keyword_suggestions",
      "serp_competitors",
      "local_businesses",
      "local_serp",
      "local_rank_grid",
      "business_questions",
      "business_profile",
      "business_reviews",
      "business_updates",
    ],
  },
} satisfies Record<
  string,
  { label: string; kinds: ResearchArchiveKind[] | undefined }
>;
type Section = keyof typeof SECTIONS;

const KIND_LABELS: Record<string, string> = {
  domain_overview: "Domain summary",
  domain_keywords: "Ranked keywords",
  domain_pages: "Top pages",
  domain_keyword_suggestions: "Keyword suggestions",
  ranked_keywords: "Ranked keywords (agent)",
  backlinks_overview: "Backlinks summary",
  backlinks_rows: "Backlinks",
  backlinks_referring_domains: "Referring domains",
  backlinks_top_pages: "Linked pages",
  keyword_research: "Keyword ideas",
  keyword_metrics: "Keyword metrics (agent)",
  serp_analysis: "SERP",
  rank_check_serp: "Rank check SERP",
  serp_competitors: "SERP competitors (agent)",
  local_businesses: "Local businesses (agent)",
  local_serp: "Local SERP (agent)",
  local_rank_grid: "Local rank grid (agent)",
  business_questions: "Business Q&A (agent)",
  business_profile: "Business profile (agent)",
  business_reviews: "Business reviews (agent)",
  business_updates: "Business posts (agent)",
  brand_lookup: "Brand lookup",
  prompt_research: "Prompt research",
  prompt_explorer: "Prompt explorer answer",
};

const ORIGIN_LABELS: Record<string, string> = {
  app: "App",
  mcp: "Agent (MCP)",
  sam: "SAM",
  schedule: "Schedule",
};

function readConfigId(params: string) {
  try {
    const parsed: unknown = JSON.parse(params);
    return typeof parsed === "object" &&
      parsed !== null &&
      "configId" in parsed &&
      typeof parsed.configId === "string"
      ? parsed.configId
      : null;
  } catch {
    return null;
  }
}

function OpenLink({
  projectId,
  entry,
  onView,
}: {
  projectId: string;
  entry: Entry;
  onView: (id: string) => void;
}) {
  const asOf = entry.fetchedAt.slice(0, 10);
  switch (entry.kind) {
    case "domain_overview":
    case "domain_keywords":
    case "domain_pages":
      return (
        <Link
          to="/p/$projectId/domain"
          params={{ projectId }}
          search={{
            domain: entry.target,
            asOf,
            tab: entry.kind === "domain_pages" ? "pages" : undefined,
          }}
          className="text-primary hover:underline"
        >
          Open
        </Link>
      );
    case "backlinks_overview":
    case "backlinks_rows":
    case "backlinks_referring_domains":
    case "backlinks_top_pages":
      return (
        <Link
          to="/p/$projectId/backlinks"
          params={{ projectId }}
          search={{
            target: entry.target,
            asOf,
            tab:
              entry.kind === "backlinks_referring_domains"
                ? "domains"
                : entry.kind === "backlinks_top_pages"
                  ? "pages"
                  : undefined,
          }}
          className="text-primary hover:underline"
        >
          Open
        </Link>
      );
    case "keyword_research":
    case "serp_analysis":
      return (
        <Link
          to="/p/$projectId/keywords"
          params={{ projectId }}
          search={{ q: entry.target, asOf }}
          className="text-primary hover:underline"
        >
          Open
        </Link>
      );
    case "rank_check_serp": {
      const configId = readConfigId(entry.params);
      return configId ? (
        <Link
          to="/p/$projectId/rank-tracking/$configId"
          params={{ projectId, configId }}
          className="text-primary hover:underline"
        >
          Open tracker
        </Link>
      ) : null;
    }
    default:
      return (
        <Button size="sm" variant="ghost" onClick={() => onView(entry.id)}>
          View
        </Button>
      );
  }
}

/** Every archived research lookup in the project, newest first. */
export function ResearchArchiveLog({ projectId }: { projectId: string }) {
  const [section, setSection] = useState<Section>("all");
  const [viewing, setViewing] = useState<string | null>(null);
  const kinds = SECTIONS[section].kinds;
  const logQuery = useInfiniteQuery({
    queryKey: ["researchArchiveLog", projectId, section],
    queryFn: ({ pageParam }) =>
      listResearchArchive({
        data: { projectId, kinds, before: pageParam, limit: 50 },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
  });
  const entries = logQuery.data?.pages.flatMap((page) => page.entries) ?? [];
  const sectionItems = Object.entries(SECTIONS).map(([value, item]) => ({
    value,
    label: item.label,
  }));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Lookup archive</h2>
          <p className="text-sm text-muted-foreground">
            Every fresh lookup made in the app, by an agent or by a schedule,
            saved in full. Open one to view that section as it was.
          </p>
        </div>
        <Select
          items={sectionItems}
          value={section}
          onValueChange={(value) => {
            if (value) setSection(value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Section">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sectionItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fetched</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-8 text-center text-muted-foreground"
                >
                  {logQuery.isLoading
                    ? "Loading…"
                    : "No archived lookups yet. They appear after the next fresh lookup."}
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {new Date(entry.fetchedAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{KIND_LABELS[entry.kind] ?? entry.kind}</TableCell>
                  <TableCell className="max-w-xs truncate font-medium">
                    {entry.target}
                  </TableCell>
                  <TableCell>
                    {ORIGIN_LABELS[entry.origin] ?? entry.origin}
                  </TableCell>
                  <TableCell className="text-right">
                    <OpenLink
                      projectId={projectId}
                      entry={entry}
                      onView={setViewing}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableCard>
      <ArchiveEntrySheet
        projectId={projectId}
        entryId={viewing}
        onClose={() => setViewing(null)}
      />
      {logQuery.hasNextPage ? (
        <Button
          size="sm"
          variant="outline"
          disabled={logQuery.isFetchingNextPage}
          onClick={() => void logQuery.fetchNextPage()}
        >
          {logQuery.isFetchingNextPage ? "Loading…" : "Load older"}
        </Button>
      ) : null}
    </div>
  );
}
