import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { QueryError } from "@/client/components/QueryState";
import { PageHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { getResearchArchiveEntry } from "@/serverFunctions/researchHistory";
import { ArchiveResultTable } from "./ArchiveResultTable";
import { ARCHIVE_KIND_LABELS, ARCHIVE_ORIGIN_LABELS } from "./archiveLabels";

function entryTitle(kind: string, target: string) {
  const kindLabel = ARCHIVE_KIND_LABELS[kind] ?? kind;
  const parts = target.split(", ");
  // Metrics lookups are archived under their whole keyword list.
  if (parts.length > 3) return `${kindLabel} · ${parts.length} keywords`;
  return `${kindLabel} · ${target}`;
}

/** A saved research result as its own page, readable without the provider. */
export function ArchiveEntryPage({
  projectId,
  entryId,
}: {
  projectId: string;
  entryId: string;
}) {
  const router = useRouter();
  const entryQuery = useQuery({
    queryKey: ["researchArchiveEntry", projectId, entryId],
    queryFn: () =>
      getResearchArchiveEntry({ data: { projectId, id: entryId } }),
    staleTime: Infinity,
  });
  const entry = entryQuery.data;
  const result: unknown = entry ? JSON.parse(entry.resultJson) : null;

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <PageHeader
          title={entry ? entryTitle(entry.kind, entry.target) : "Saved result"}
          description={
            entry
              ? `Fetched ${new Date(entry.fetchedAt).toLocaleString()} · by ${ARCHIVE_ORIGIN_LABELS[entry.origin] ?? entry.origin}${entry.locationCode ? ` · market ${entry.locationCode}/${entry.languageCode ?? ""}` : ""} · saved copy, read without new charges`
              : undefined
          }
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.history.back()}
            >
              Back
            </Button>
          }
        />
        {entry && entry.target.split(", ").length > 3 ? (
          <p className="text-sm text-muted-foreground">{entry.target}</p>
        ) : null}
        {entryQuery.isError ? (
          <QueryError
            error={entryQuery.error}
            fallback="Failed to load this saved result."
            onRetry={() => void entryQuery.refetch()}
            isRetrying={entryQuery.isFetching}
          />
        ) : null}
        {entry ? <ArchiveResultTable result={result} /> : null}
      </div>
    </div>
  );
}
