import { Line, LineChart } from "recharts";
import { sortBy } from "remeda";
import {
  ChartGrid,
  ChartXAxis,
  ChartYAxis,
} from "@/client/components/ChartAxes";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/client/components/ui/chart";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";

// The project's own domain is always the first, strongest color.
const OWN_COLOR = "#2563eb";
const COMPETITOR_COLORS = [
  "#f97316",
  "#14b8a6",
  "#a855f7",
  "#eab308",
  "#ec4899",
  "#64748b",
  "#22c55e",
  "#ef4444",
  "#0ea5e9",
  "#84cc16",
];

export type HistorySeries = {
  domain: string;
  own: boolean;
  points: Array<{ date: string; value: number | null }>;
};

const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
const shortDate = (value: string | number) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

/** One line per domain over the stored snapshot days; gaps are joined. */
export function HistoryMetricChart({
  title,
  series,
}: {
  title: string;
  series: HistorySeries[];
}) {
  // Chart keys must be CSS-safe, so domains map to d0, d1, ...
  const keyed = series.map((entry, index) => ({ ...entry, key: `d${index}` }));
  let competitor = 0;
  const config: ChartConfig = Object.fromEntries(
    keyed.map((entry) => [
      entry.key,
      {
        label: entry.domain,
        color: entry.own
          ? OWN_COLOR
          : COMPETITOR_COLORS[competitor++ % COMPETITOR_COLORS.length],
      },
    ]),
  );
  const byDay = new Map<number, Record<string, number | null>>();
  for (const entry of keyed)
    for (const point of entry.points) {
      const time = Date.parse(point.date);
      byDay.set(time, { ...byDay.get(time), [entry.key]: point.value });
    }
  const data = sortBy([...byDay.entries()], ([time]) => time).map(
    ([time, values]) => ({ time, ...values }),
  );

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No snapshots in this period yet.
          </p>
        ) : (
          <ChartContainer
            config={config}
            className="h-[240px] w-full"
            aria-label={`${title} over time by domain`}
          >
            <LineChart
              data={data}
              margin={{ left: 0, right: 12, top: 8, bottom: 0 }}
            >
              <ChartGrid />
              <ChartXAxis
                dataKey="time"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={shortDate}
              />
              <ChartYAxis
                tickFormatter={(value: number) => compact.format(value)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(label) =>
                      new Date(Number(label)).toLocaleDateString()
                    }
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {keyed.map((entry) => (
                <Line
                  key={entry.key}
                  type="monotone"
                  dataKey={entry.key}
                  stroke={`var(--color-${entry.key})`}
                  strokeWidth={entry.own ? 2.5 : 1.5}
                  dot={data.length < 30}
                  connectNulls
                />
              ))}
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
