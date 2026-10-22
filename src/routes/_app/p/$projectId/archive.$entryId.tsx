import { createFileRoute } from "@tanstack/react-router";
import { ArchiveEntryPage } from "@/client/features/research-history/ArchiveEntryPage";

export const Route = createFileRoute("/_app/p/$projectId/archive/$entryId")({
  component: ArchiveEntryRoute,
});

function ArchiveEntryRoute() {
  const { projectId, entryId } = Route.useParams();
  return (
    <ArchiveEntryPage key={entryId} projectId={projectId} entryId={entryId} />
  );
}
