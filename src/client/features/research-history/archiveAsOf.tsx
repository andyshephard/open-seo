import { useQuery } from "@tanstack/react-query";
import { History, RefreshCw } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
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
import { ArchiveEntrySheet } from "./ArchiveEntrySheet";
import { ARCHIVE_KIND_LABELS, ARCHIVE_ORIGIN_LABELS } from "./archiveLabels";
import type { ResearchArchiveKind } from "@/types/schemas/researchHistory";

// What a research page's queries should read: an archived day (YYYY-MM-DD),
// or stored data within the freshness window, or — right after "Refresh live"
// on this exact view — a live copy. Query hooks read it so every tab of the
// page switches together; `refreshNonce` keeps refreshed results under their
// own query keys.
type ArchiveViewState = {
  asOf: string | undefined;
  refresh: boolean;
  refreshNonce: number;
};

const ArchiveViewContext = createContext<ArchiveViewState>({
  asOf: undefined,
  refresh: false,
  refreshNonce: 0,
});

export function useArchiveView() {
  return useContext(ArchiveViewContext);
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
  viewKey,
  asOf,
  onAsOfChange,
  children,
}: {
  projectId: string;
  kinds: ResearchArchiveKind[];
  target: string;
  /** Identifies the current view (URL search); a refresh applies only to it. */
  viewKey: string;
  asOf: string | undefined;
  onAsOfChange: (asOf: string | undefined) => void;
  children: ReactNode;
}) {
  const trimmed = target.trim();
  const [refreshed, setRefreshed] = useState({ nonce: 0, viewKey: "" });
  const [viewing, setViewing] = useState<string | null>(null);
  const state: ArchiveViewState = {
    asOf,
    refresh: refreshed.nonce > 0 && refreshed.viewKey === viewKey && !asOf,
    refreshNonce: refreshed.nonce,
  };
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
    <ArchiveViewContext.Provider value={state}>
      {trimmed !== "" ? (
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
                  before this day show as not captured; every result saved that
                  day is listed below.
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
              <>
                <span className="text-muted-foreground">
                  Stored results are reused until they go stale.
                  {options.length > 0
                    ? ` ${options.length} archived ${options.length === 1 ? "day" : "days"} for this target.`
                    : ""}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  title="Buys fresh data for this view from the provider"
                  onClick={() =>
                    setRefreshed((previous) => ({
                      nonce: previous.nonce + 1,
                      viewKey,
                    }))
                  }
                >
                  <RefreshCw data-icon="inline-start" />
                  Refresh live (uses credits)
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
      {asOf ? (
        <div className="px-4 pt-2 md:px-6">
          <div className="mx-auto flex max-w-7xl flex-wrap gap-2">
            {(datesQuery.data?.entries ?? [])
              .filter((entry) => entry.fetchedAt.slice(0, 10) === asOf)
              .map((entry) => (
                <Button
                  key={entry.id}
                  size="sm"
                  variant="ghost"
                  onClick={() => setViewing(entry.id)}
                >
                  {ARCHIVE_KIND_LABELS[entry.kind] ?? entry.kind}
                  {entry.params !== "{}" ? ` ${entry.params}` : ""} ·{" "}
                  {ARCHIVE_ORIGIN_LABELS[entry.origin] ?? entry.origin}
                </Button>
              ))}
          </div>
        </div>
      ) : null}
      <ArchiveEntrySheet
        projectId={projectId}
        entryId={viewing}
        onClose={() => setViewing(null)}
      />
      {children}
    </ArchiveViewContext.Provider>
  );
}
