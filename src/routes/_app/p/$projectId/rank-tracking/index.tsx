import { useState } from "react";
import { SavedRunsList } from "@/client/features/research-history/SavedRunsList";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { RankTrackingDomainList } from "@/client/features/rank-tracking/RankTrackingDomainList";
import { RankTrackingConfigModal } from "@/client/features/rank-tracking/RankTrackingConfigModal";
import { rankTrackingListSearchSchema } from "@/types/schemas/rank-tracking-search";

export const Route = createFileRoute("/_app/p/$projectId/rank-tracking/")({
  validateSearch: rankTrackingListSearchSchema,
  // The project switcher keeps this page; a pending search must not follow.
  remountDeps: ({ params }) => params.projectId,
  search: {
    middlewares: [stripSearchParams({ q: "" })],
  },
  component: RankTrackingIndex,
});

function RankTrackingIndex() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const queryClient = useQueryClient();
  const [showConfigModal, setShowConfigModal] = useState(false);

  const invalidateConfigs = () => {
    void queryClient.invalidateQueries({
      queryKey: ["rankTrackingConfigs", projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["rankTrackingConfigSummaries", projectId],
    });
  };

  return (
    <>
      <RankTrackingDomainList
        projectId={projectId}
        search={search}
        onSearchChange={(next) => {
          void navigate({
            from: Route.fullPath,
            search: next,
            replace: true,
          });
        }}
        onAddDomain={() => setShowConfigModal(true)}
      />
      <div className="px-4 pb-6 md:px-6">
        <div className="mx-auto max-w-7xl">
          <SavedRunsList
            projectId={projectId}
            kinds={["rank_check_serp", "local_rank_grid", "local_serp"]}
            renderLink={() => null}
          />
        </div>
      </div>

      {showConfigModal && (
        <RankTrackingConfigModal
          projectId={projectId}
          existingConfig={null}
          onClose={() => setShowConfigModal(false)}
          onConfigCreated={invalidateConfigs}
          onSaved={(createdConfigId) => {
            setShowConfigModal(false);
            invalidateConfigs();
            if (createdConfigId) {
              void navigate({
                to: "/p/$projectId/rank-tracking/$configId",
                params: { projectId, configId: createdConfigId },
              });
            }
          }}
        />
      )}
    </>
  );
}
