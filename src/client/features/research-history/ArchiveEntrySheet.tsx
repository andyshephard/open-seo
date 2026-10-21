import { useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/client/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { getResearchArchiveEntry } from "@/serverFunctions/researchHistory";

const MAX_ROWS = 300;

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first array of objects in a result: the rows most results are made of. */
function findRows(value: unknown): Row[] | null {
  if (Array.isArray(value)) return value.every(isRow) ? value : null;
  if (!isRow(value)) return null;
  for (const child of Object.values(value)) {
    const rows = findRows(child);
    if (rows && rows.length > 0) return rows;
  }
  return null;
}

function cellText(value: unknown) {
  if (value == null) return "—";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  return JSON.stringify(value);
}

/** Read-only view of any archived lookup, as a table when it holds rows. */
export function ArchiveEntrySheet({
  projectId,
  entryId,
  onClose,
}: {
  projectId: string;
  entryId: string | null;
  onClose: () => void;
}) {
  const entryQuery = useQuery({
    enabled: entryId != null,
    queryKey: ["researchArchiveEntry", projectId, entryId],
    queryFn: () =>
      getResearchArchiveEntry({ data: { projectId, id: entryId ?? "" } }),
    staleTime: Infinity,
  });
  const entry = entryQuery.data;
  const result: unknown = entry ? JSON.parse(entry.resultJson) : null;
  const rows = findRows(result);
  const columns = rows
    ? [
        ...new Set(
          rows
            .slice(0, 20)
            .flatMap((row) =>
              Object.keys(row).filter((key) => typeof row[key] !== "object"),
            ),
        ),
      ].slice(0, 12)
    : [];

  return (
    <Sheet open={entryId != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{entry?.target ?? "Archived lookup"}</SheetTitle>
          <SheetDescription>
            {entry
              ? `${entry.kind} · fetched ${new Date(entry.fetchedAt).toLocaleString()} · via ${entry.origin}`
              : "Loading…"}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {rows && columns.length > 0 ? (
            <div className="overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {columns.map((column) => (
                      <TableHead key={column}>{column}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, MAX_ROWS).map((row, index) => (
                    <TableRow key={index}>
                      {columns.map((column) => (
                        <TableCell
                          key={column}
                          className="max-w-xs truncate text-xs"
                        >
                          {cellText(row[column])}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : entry ? (
            <pre className="overflow-auto rounded-md border p-3 text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          ) : null}
          {rows && rows.length > MAX_ROWS ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Showing {MAX_ROWS} of {rows.length} rows.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
