import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { QueryError } from "@/client/components/QueryState";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { getResearchHistory } from "@/serverFunctions/researchHistory";
import { RESEARCH_HISTORY_MONTHS } from "@/types/schemas/researchHistory";
import { HistoryMetricChart, type HistorySeries } from "./HistoryMetricChart";
import { ResearchArchiveLog } from "./ResearchArchiveLog";
import { SearchConsoleHistorySection } from "./SearchConsoleHistorySection";
import { ResearchSnapshotScheduleCard } from "./ResearchSnapshotScheduleCard";

type History = Awaited<ReturnType<typeof getResearchHistory>>;
type DomainHistory = History["domains"][number];
type Months = (typeof RESEARCH_HISTORY_MONTHS)[number];

const RANGE_ITEMS = RESEARCH_HISTORY_MONTHS.map((months) => ({
  value: String(months),
  label: `${months} months`,
  icon: null,
}));

const number = new Intl.NumberFormat();

function overviewSeries(
  domains: DomainHistory[],
  pick: (point: DomainHistory["overview"][number]) => number | null,
): HistorySeries[] {
  return domains.map((entry) => ({
    domain: entry.domain,
    own: entry.own,
    points: entry.overview.map((point) => ({
      date: point.date,
      value: pick(point),
    })),
  }));
}

function backlinkSeries(
  domains: DomainHistory[],
  pick: (point: DomainHistory["backlinks"][number]) => number | null,
): HistorySeries[] {
  return domains.map((entry) => ({
    domain: entry.domain,
    own: entry.own,
    points: entry.backlinks.map((point) => ({
      date: point.date,
      value: pick(point),
    })),
  }));
}

/** Latest value plus its change since the first snapshot in the period. */
function Latest({ points }: { points: Array<number | null | undefined> }) {
  const known = points.filter((value): value is number => value != null);
  const last = known.at(-1);
  if (last == null) return <span className="text-muted-foreground">—</span>;
  const delta = last - (known[0] ?? last);
  return (
    <span>
      {number.format(last)}
      {delta !== 0 ? (
        <span
          className={
            delta > 0
              ? "ml-1 text-xs text-emerald-600"
              : "ml-1 text-xs text-red-600"
          }
        >
          {delta > 0 ? "+" : ""}
          {number.format(delta)}
        </span>
      ) : null}
    </span>
  );
}

export function ResearchHistoryPage({ projectId }: { projectId: string }) {
  const [months, setMonths] = useState<Months>(12);
  const historyQuery = useQuery({
    queryKey: ["researchHistory", projectId, months],
    queryFn: () => getResearchHistory({ data: { projectId, months } }),
    placeholderData: keepPreviousData,
  });
  const history = historyQuery.data;
  const domains = history?.domains ?? [];
  const keywords = (history?.keywords ?? []).filter(
    (row) => row.snapshots.length > 0,
  );

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Research History</h1>
            <p className="text-sm text-muted-foreground">
              Your domain against saved competitors over time. Every domain
              overview, backlinks and keyword lookup in this project adds a
              dated snapshot at no extra cost.
            </p>
          </div>
          <SegmentedToggle
            showLabels
            items={RANGE_ITEMS}
            value={String(months)}
            onChange={(value) => {
              const next = RESEARCH_HISTORY_MONTHS.find(
                (option) => String(option) === value,
              );
              if (next) setMonths(next);
            }}
          />
        </div>

        <ResearchSnapshotScheduleCard projectId={projectId} />

        {historyQuery.isError ? (
          <QueryError
            error={historyQuery.error}
            fallback="Failed to load research history."
            onRetry={() => void historyQuery.refetch()}
            isRetrying={historyQuery.isFetching}
          />
        ) : null}

        {history ? (
          <>
            <TableCard>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead className="text-right">
                      Organic traffic
                    </TableHead>
                    <TableHead className="text-right">Keywords</TableHead>
                    <TableHead className="text-right">Top 10</TableHead>
                    <TableHead className="text-right">
                      Referring domains
                    </TableHead>
                    <TableHead className="text-right">Backlinks</TableHead>
                    <TableHead className="text-right">Snapshots</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {domains.map((entry) => (
                    <TableRow key={entry.domain}>
                      <TableCell className="font-medium">
                        {entry.domain}
                        {entry.own ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            you
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <Latest
                          points={entry.overview.map((p) => p.organicTraffic)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Latest
                          points={entry.overview.map((p) => p.organicKeywords)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Latest
                          points={entry.overview.map((p) => p.top10Keywords)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Latest
                          points={entry.backlinks.map(
                            (p) => p.referringDomains,
                          )}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Latest
                          points={entry.backlinks.map((p) => p.backlinks)}
                        />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {Math.max(
                          entry.overview.length,
                          entry.backlinks.length,
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableCard>

            <div className="grid gap-4 lg:grid-cols-2">
              <HistoryMetricChart
                title="Organic traffic"
                series={overviewSeries(domains, (p) => p.organicTraffic)}
              />
              <HistoryMetricChart
                title="Organic keywords"
                series={overviewSeries(domains, (p) => p.organicKeywords)}
              />
              <HistoryMetricChart
                title="Keywords in the top 10"
                series={overviewSeries(domains, (p) => p.top10Keywords)}
              />
              <HistoryMetricChart
                title="Referring domains"
                series={backlinkSeries(domains, (p) => p.referringDomains)}
              />
              <HistoryMetricChart
                title="Backlinks"
                series={backlinkSeries(domains, (p) => p.backlinks)}
              />
              <HistoryMetricChart
                title="Domain rank"
                series={backlinkSeries(domains, (p) => p.rank)}
              />
              <HistoryMetricChart
                title="Ahrefs Domain Rating"
                series={backlinkSeries(domains, (p) => p.domainRating)}
              />
            </div>

            <TableCard>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Saved keyword</TableHead>
                    <TableHead className="text-right">Search volume</TableHead>
                    <TableHead className="text-right">Difficulty</TableHead>
                    <TableHead className="text-right">CPC</TableHead>
                    <TableHead className="text-right">Snapshots</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keywords.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-8 text-center text-muted-foreground"
                      >
                        No keyword snapshots yet. Refresh saved keyword metrics,
                        or turn on scheduled snapshots with keywords.
                      </TableCell>
                    </TableRow>
                  ) : (
                    keywords.map((row) => (
                      <TableRow key={row.keyword}>
                        <TableCell className="font-medium">
                          {row.keyword}
                        </TableCell>
                        <TableCell className="text-right">
                          <Latest
                            points={row.snapshots.map((p) => p.searchVolume)}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Latest
                            points={row.snapshots.map(
                              (p) => p.keywordDifficulty,
                            )}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          {row.snapshots.at(-1)?.cpc?.toFixed(2) ?? "—"}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {row.snapshots.length}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableCard>
          </>
        ) : null}

        <SearchConsoleHistorySection projectId={projectId} days={months * 30} />

        <ResearchArchiveLog projectId={projectId} />
      </div>
    </div>
  );
}
