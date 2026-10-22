import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";
import { sort as sortRows, sortBy } from "remeda";
import { Input } from "@/client/components/ui/input";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";

// Renders any archived research result as a readable table: the result's
// main list of rows, with friendly column names, formatted values, a search
// trend sparkline, sortable headers and a text filter. Results without rows
// fall back to their summary fields.

type Row = Record<string, unknown>;

const COLUMN_LABELS: Record<string, string> = {
  keyword: "Keyword",
  searchVolume: "Search volume",
  search_volume: "Search volume",
  keywordDifficulty: "Difficulty",
  keyword_difficulty: "Difficulty",
  cpc: "CPC",
  competition: "Competition",
  competitionLevel: "Competition level",
  intent: "Intent",
  monthlySearches: "Trend (12 months)",
  trend: "Trend (12 months)",
  domain: "Domain",
  url: "URL",
  title: "Title",
  position: "Position",
  rank: "Rank",
  rank_group: "Position",
  rank_absolute: "Position (absolute)",
  etv: "Est. traffic",
  traffic: "Est. traffic",
  organicTraffic: "Organic traffic",
  organicKeywords: "Organic keywords",
  backlinks: "Backlinks",
  referringDomains: "Referring domains",
  referring_domains: "Referring domains",
  domainRank: "Domain rank",
  spamScore: "Spam score",
  firstSeen: "First seen",
  lastSeen: "Last seen",
  first_seen: "First seen",
  anchor: "Anchor",
  urlFrom: "Linking page",
  urlTo: "Target page",
  page: "Page",
};

// Columns that belong at the front, in this order, when present.
const LEADING_COLUMNS = ["keyword", "domain", "title", "url", "page"];

const number = new Intl.NumberFormat();

function label(column: string) {
  if (COLUMN_LABELS[column]) return COLUMN_LABELS[column];
  const words = column
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first non-empty array of objects in a result: its rows. */
function findRows(value: unknown): Row[] | null {
  if (Array.isArray(value))
    return value.length > 0 && value.every(isRow) ? value : null;
  if (!isRow(value)) return null;
  for (const child of Object.values(value)) {
    const rows = findRows(child);
    if (rows) return rows;
  }
  return null;
}

type TrendPoint = { year: number; month: number; searchVolume: number };

function isTrend(value: unknown): value is TrendPoint[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (point) => isRow(point) && typeof point.searchVolume === "number",
    )
  );
}

function Sparkline({ points }: { points: TrendPoint[] }) {
  const ordered = sortBy(points, [(p) => p.year * 12 + p.month, "asc"]);
  const values = ordered.map((point) => point.searchVolume);
  const max = Math.max(...values, 1);
  const width = 96;
  const height = 24;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const path = values
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Monthly searches from ${number.format(values[0] ?? 0)} to ${number.format(values.at(-1) ?? 0)}`}
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

function Cell({ column, value }: { column: string; value: unknown }) {
  if (value == null || value === "")
    return <span className="text-muted-foreground">—</span>;
  if (isTrend(value)) return <Sparkline points={value} />;
  if (typeof value === "number") {
    if (column === "cpc") return <>${value.toFixed(2)}</>;
    if (column === "competition" && value <= 1)
      return <>{Math.round(value * 100)}%</>;
    return <>{number.format(Math.round(value * 100) / 100)}</>;
  }
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value))
      return (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          {value.replace(/^https?:\/\//, "")}
        </a>
      );
    return <>{value}</>;
  }
  return <span className="text-muted-foreground">{JSON.stringify(value)}</span>;
}

function columnsFor(rows: Row[]) {
  const seen = new Set<string>();
  for (const row of rows.slice(0, 50))
    for (const [key, value] of Object.entries(row))
      if (!isRow(value) && (!Array.isArray(value) || isTrend(value)))
        seen.add(key);
  const leading = LEADING_COLUMNS.filter((column) => seen.has(column));
  return [...leading, ...[...seen].filter((c) => !leading.includes(c))].slice(
    0,
    14,
  );
}

function sortText(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function compare(a: unknown, b: unknown) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a == null) return 1;
  if (b == null) return -1;
  return sortText(a).localeCompare(sortText(b));
}

export function ArchiveResultTable({ result }: { result: unknown }) {
  const rows = useMemo(() => findRows(result), [result]);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(
    null,
  );

  if (!rows) {
    const fields = isRow(result)
      ? Object.entries(isRow(result.overview) ? result.overview : result)
      : [];
    return (
      <TableCard>
        <Table>
          <TableBody>
            {fields
              .filter(([, value]) => !isRow(value) && !Array.isArray(value))
              .map(([key, value]) => (
                <TableRow key={key}>
                  <TableCell className="font-medium">{label(key)}</TableCell>
                  <TableCell>
                    <Cell column={key} value={value} />
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TableCard>
    );
  }

  const columns = columnsFor(rows);
  const needle = filter.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      !needle ||
      columns.some(
        (column) =>
          typeof row[column] === "string" &&
          String(row[column]).toLowerCase().includes(needle),
      ),
  );
  const sorted = sort
    ? sortRows(visible, (a, b) => {
        const order = compare(a[sort.column], b[sort.column]);
        return sort.desc ? -order : order;
      })
    : visible;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter rows"
          className="max-w-xs"
          aria-label="Filter rows"
        />
        <span className="text-sm text-muted-foreground">
          {number.format(sorted.length)} of {number.format(rows.length)} rows
        </span>
      </div>
      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() =>
                      setSort((previous) =>
                        previous?.column === column
                          ? { column, desc: !previous.desc }
                          : { column, desc: true },
                      )
                    }
                  >
                    {label(column)}
                    {sort?.column === column ? (
                      sort.desc ? (
                        <ArrowDown className="size-3" aria-hidden />
                      ) : (
                        <ArrowUp className="size-3" aria-hidden />
                      )
                    ) : null}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row, index) => (
              <TableRow key={index}>
                {columns.map((column) => (
                  <TableCell key={column} className="max-w-md truncate">
                    <Cell column={column} value={row[column]} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableCard>
    </div>
  );
}
