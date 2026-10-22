import { useQuery } from "@tanstack/react-query";
import { Bot, Clock, History } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent, CardHeader } from "@/client/components/ui/card";
import { listResearchArchive } from "@/serverFunctions/researchHistory";
import type { ResearchArchiveKind } from "@/types/schemas/researchHistory";
import { Link } from "@tanstack/react-router";
import { ARCHIVE_KIND_LABELS, ARCHIVE_ORIGIN_LABELS } from "./archiveLabels";

const MAX_RUNS = 15;

type Entry = Awaited<ReturnType<typeof listResearchArchive>>["entries"][number];

/** One run: every result archived for a target on one day. */
type SavedRun = {
  target: string;
  /** YYYY-MM-DD of the newest result in the run. */
  date: string;
  entries: Entry[];
};

type ClickableProps = { className: string; children: ReactNode };

/**
 * A metrics refresh is archived under its whole keyword list; name it by its
 * size instead of listing every keyword.
 */
function runTitle(run: SavedRun) {
  if (run.entries.every((entry) => entry.kind === "keyword_metrics")) {
    const count = run.target.split(", ").length;
    return `Keyword metrics for ${count} keyword${count !== 1 ? "s" : ""}`;
  }
  return run.target;
}

function groupRuns(entries: Entry[]): SavedRun[] {
  const runs = new Map<string, SavedRun>();
  for (const entry of entries) {
    const date = entry.fetchedAt.slice(0, 10);
    const key = `${entry.target}\n${date}`;
    const run = runs.get(key) ?? { target: entry.target, date, entries: [] };
    run.entries.push(entry);
    runs.set(key, run);
  }
  return [...runs.values()].slice(0, MAX_RUNS);
}

/**
 * Every saved run of this page's lookups, by anyone — the user, an agent over
 * MCP, SAM or a schedule — read from the server archive. Each run opens the
 * page as it was that day, and each saved result can be viewed directly.
 */
export function SavedRunsList({
  projectId,
  kinds,
  renderLink,
}: {
  projectId: string;
  kinds: ResearchArchiveKind[];
  /** The page link that reopens a run, or null when only View applies. */
  renderLink: (run: SavedRun, props: ClickableProps) => ReactNode | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const runsQuery = useQuery({
    queryKey: ["savedRuns", projectId, kinds],
    queryFn: () =>
      listResearchArchive({ data: { projectId, kinds, limit: 200 } }),
  });
  const runs = groupRuns(runsQuery.data?.entries ?? []);
  if (runs.length === 0) return null;

  return (
    <Card size="lg">
      <CardHeader className="flex items-center gap-2 text-muted-foreground">
        <Bot className="size-4" aria-hidden />
        {runs.length} saved run{runs.length !== 1 ? "s" : ""} by you and agents
      </CardHeader>
      <CardContent>
        <ul className="grid min-w-0 gap-2">
          {runs.map((run) => {
            const key = `${run.target}\n${run.date}`;
            const origins = [
              ...new Set(
                run.entries.map(
                  (entry) =>
                    ARCHIVE_ORIGIN_LABELS[entry.origin] ?? entry.origin,
                ),
              ),
            ].join(", ");
            const content = (
              <>
                <History
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="truncate font-medium">{runTitle(run)}</p>
                  <p className="truncate text-muted-foreground">
                    {new Date(`${run.date}T00:00:00Z`).toLocaleDateString(
                      undefined,
                      { timeZone: "UTC", dateStyle: "medium" },
                    )}{" "}
                    · {run.entries.length} saved result
                    {run.entries.length !== 1 ? "s" : ""} · {origins}
                  </p>
                </div>
              </>
            );
            const className =
              "flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left transition-colors outline-none hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50";
            return (
              <li
                key={key}
                className="min-w-0 rounded-lg border border-border p-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {renderLink(run, { className, children: content }) ?? (
                    <div className={className} title={run.target}>
                      {content}
                    </div>
                  )}
                  {run.entries.length === 1 ? (
                    <Button
                      size="sm"
                      variant="outline"
                      nativeButton={false}
                      render={
                        <Link
                          to="/p/$projectId/archive/$entryId"
                          params={{ projectId, entryId: run.entries[0].id }}
                        />
                      }
                    >
                      View data
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setExpanded(expanded === key ? null : key)}
                    >
                      View data
                    </Button>
                  )}
                </div>
                {expanded === key ? (
                  <ul className="mt-2 grid gap-1 border-t border-border pt-2">
                    {run.entries.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Clock
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {ARCHIVE_KIND_LABELS[entry.kind] ?? entry.kind}
                          {entry.params !== "{}" ? (
                            <span className="text-muted-foreground">
                              {" "}
                              {entry.params}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(entry.fetchedAt).toLocaleTimeString()} ·{" "}
                          {ARCHIVE_ORIGIN_LABELS[entry.origin] ?? entry.origin}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          nativeButton={false}
                          render={
                            <Link
                              to="/p/$projectId/archive/$entryId"
                              params={{ projectId, entryId: entry.id }}
                            />
                          }
                        >
                          Open
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
