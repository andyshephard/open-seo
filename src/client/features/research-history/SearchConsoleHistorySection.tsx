import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
import { getSearchConsoleHistory } from "@/serverFunctions/researchHistory";
import { HistoryMetricChart } from "./HistoryMetricChart";

const DIMENSIONS = [
  { value: "query", label: "Queries", icon: null },
  { value: "page", label: "Pages", icon: null },
] as const;

const number = new Intl.NumberFormat();

function Change({
  current,
  previous,
  lowerIsBetter = false,
}: {
  current: number | null;
  previous: number | null;
  lowerIsBetter?: boolean;
}) {
  if (current == null || previous == null) return null;
  const delta = Math.round((current - previous) * 10) / 10;
  if (delta === 0) return null;
  const better = lowerIsBetter ? delta < 0 : delta > 0;
  return (
    <span
      className={
        better ? "ml-1 text-xs text-emerald-600" : "ml-1 text-xs text-red-600"
      }
    >
      {delta > 0 ? "+" : ""}
      {number.format(delta)}
    </span>
  );
}

/** OpenSEO's daily stored copy of Search Console, compared with the prior period. */
export function SearchConsoleHistorySection({
  projectId,
  days,
}: {
  projectId: string;
  days: number;
}) {
  const [dimension, setDimension] = useState<"query" | "page">("query");
  const historyQuery = useQuery({
    queryKey: ["searchConsoleHistory", projectId, days, dimension],
    queryFn: () =>
      getSearchConsoleHistory({
        data: { projectId, days, dimension, limit: 50 },
      }),
  });
  const history = historyQuery.data;
  if (!history) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Search Console history</h2>
          <p className="text-sm text-muted-foreground">
            {history.synced
              ? `Stored daily by OpenSEO, ${history.from} to ${history.to}. Kept beyond Google's 16-month limit; read without calling Google.`
              : "Connect Search Console in project settings; OpenSEO then stores a daily copy of its data."}
          </p>
        </div>
        {history.synced ? (
          <SegmentedToggle
            showLabels
            items={[...DIMENSIONS]}
            value={dimension}
            onChange={setDimension}
          />
        ) : null}
      </div>
      {history.synced ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <HistoryMetricChart
              title="Clicks"
              series={[
                {
                  domain: "Clicks",
                  own: true,
                  points: history.totals.map((day) => ({
                    date: day.date,
                    value: day.clicks,
                  })),
                },
              ]}
            />
            <HistoryMetricChart
              title="Impressions"
              series={[
                {
                  domain: "Impressions",
                  own: true,
                  points: history.totals.map((day) => ({
                    date: day.date,
                    value: day.impressions,
                  })),
                },
              ]}
            />
          </div>
          <TableCard>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {dimension === "query" ? "Query" : "Page"}
                  </TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Impressions</TableHead>
                  <TableHead className="text-right">Avg position</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.rows.map((row) => (
                  <TableRow key={row.value}>
                    <TableCell className="max-w-md truncate font-medium">
                      {row.value}
                    </TableCell>
                    <TableCell className="text-right">
                      {number.format(row.clicks)}
                      <Change
                        current={row.clicks}
                        previous={row.previousClicks}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      {number.format(row.impressions)}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.position == null ? "—" : row.position.toFixed(1)}
                      <Change
                        current={row.position}
                        previous={row.previousPosition}
                        lowerIsBetter
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
        </>
      ) : null}
    </div>
  );
}
