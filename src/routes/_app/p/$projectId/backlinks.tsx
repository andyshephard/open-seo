import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BacklinksPage } from "@/client/features/backlinks/BacklinksPage";
import {
  DEFAULT_BACKLINKS_PAGE_SIZE,
  backlinksSearchSchema,
} from "@/types/schemas/backlinks";
import { ArchiveView } from "@/client/features/research-history/archiveAsOf";
import { defaultScopeForInput } from "@/shared/researchScope";

export const Route = createFileRoute("/_app/p/$projectId/backlinks")({
  validateSearch: backlinksSearchSchema,
  component: BacklinksRoute,
});

function BacklinksRoute() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const {
    target = "",
    scope: rawScope,
    tab = "backlinks",
    page = 1,
    size = DEFAULT_BACKLINKS_PAGE_SIZE,
    sort,
    order,
    view,
    includeSpam,
    asOf,
  } = search;
  const scope = rawScope ?? defaultScopeForInput(target);

  return (
    <ArchiveView
      projectId={projectId}
      kinds={[
        "backlinks_overview",
        "backlinks_rows",
        "backlinks_referring_domains",
        "backlinks_top_pages",
      ]}
      target={target}
      viewKey={JSON.stringify(search)}
      asOf={asOf}
      onAsOfChange={(next) =>
        void navigate({ search: (prev) => ({ ...prev, asOf: next }) })
      }
    >
      <BacklinksPage
        projectId={projectId}
        navigate={navigate}
        searchState={{
          target,
          scope,
          // Referring domains can't be filtered to a subfolder.
          tab: scope === "subfolder" && tab === "domains" ? "backlinks" : tab,
          page,
          pageSize: size,
          sort,
          order,
          view,
          includeSpam,
        }}
      />
    </ArchiveView>
  );
}
