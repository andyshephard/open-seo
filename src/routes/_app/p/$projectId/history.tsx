import { createFileRoute } from "@tanstack/react-router";
import { ResearchHistoryPage } from "@/client/features/research-history/ResearchHistoryPage";

export const Route = createFileRoute("/_app/p/$projectId/history")({
  component: HistoryRoute,
});

function HistoryRoute() {
  const { projectId } = Route.useParams();
  return <ResearchHistoryPage key={projectId} projectId={projectId} />;
}
