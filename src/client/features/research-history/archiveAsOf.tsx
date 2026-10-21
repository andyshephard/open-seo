import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { unique } from "remeda";
import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import { listResearchArchive } from "@/serverFunctions/researchHistory";
import type { ResearchArchiveKind } from "@/types/schemas/researchHistory";

// The archived day (YYYY-MM-DD) a research page is showing, or undefined for
// live data. Query hooks read it so every tab of the page switches together.
const ArchiveAsOfContext = createContext<string | undefined>(undefined);

export function useArchiveAsOf() {
  return useContext(ArchiveAsOfContext);
}

const LIVE = "live";

/**
 * A "Live / archived date" picker above a research page, listing the days the
 * current target has archived results, plus the provider for the page below.
 */
export function ArchiveView({
  projectId,
  kinds,
  target,
  asOf,
  onAsOfChange,
  children,
}: {
  projectId: string;
  kinds: ResearchArchiveKind[];
  target: string;
  asOf: string | undefined;
  onAsOfChange: (asOf: string | undefined) => void;
  children: ReactNode;
}) {
  const trimmed = target.trim();
  const datesQuery = useQuery({
    enabled: trimmed !== "",
    queryKey: ["researchArchiveDates", projectId, kinds, trimmed],
    queryFn: () =>
      listResearchArchive({
        data: { projectId, kinds, target: trimmed, limit: 200 },
      }),
    staleTime: 60_000,
  });
  const dates = unique(
    (datesQuery.data?.entries ?? []).map((entry) =>
      entry.fetchedAt.slice(0, 10),
    ),
  );
  // Keep a date from a shared link selectable even before the list loads.
  const options = asOf && !dates.includes(asOf) ? [asOf, ...dates] : dates;
  const items = [
    { value: LIVE, label: "Live data" },
    ...options.map((date) => ({
      value: date,
      label: new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
        timeZone: "UTC",
        dateStyle: "medium",
      }),
    })),
  ];

  return (
    <ArchiveAsOfContext.Provider value={asOf}>
      {trimmed !== "" && (options.length > 0 || asOf) ? (
        <div className="px-4 pt-4 md:px-6">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 text-sm">
            <History className="size-4 text-muted-foreground" />
            <span className="text-muted-foreground">Showing</span>
            <Select
              items={items}
              value={asOf ?? LIVE}
              onValueChange={(value) =>
                onAsOfChange(
                  typeof value === "string" && value !== LIVE
                    ? value
                    : undefined,
                )
              }
            >
              <SelectTrigger size="sm" aria-label="Archived date">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {asOf ? (
              <>
                <span className="text-muted-foreground">
                  Archived results, read-only and free. Views not fetched on or
                  before this day show as not captured.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAsOfChange(undefined)}
                >
                  Back to live
                </Button>
              </>
            ) : (
              <span className="text-muted-foreground">
                {options.length} archived{" "}
                {options.length === 1 ? "day" : "days"} for this target
              </span>
            )}
          </div>
        </div>
      ) : null}
      {children}
    </ArchiveAsOfContext.Provider>
  );
}
