import { SavedRunsList } from "@/client/features/research-history/SavedRunsList";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { SearchPerformancePage } from "@/client/features/search-performance/SearchPerformancePage";
import {
  SEARCH_PERFORMANCE_DEFAULT_PAGE_SIZE,
  searchPerformanceSearchSchema,
} from "@/types/schemas/search-performance";

export const Route = createFileRoute("/_app/p/$projectId/search-performance")({
  validateSearch: searchPerformanceSearchSchema,
  search: {
    middlewares: [
      stripSearchParams({
        tab: "striking",
        range: "last_28_days",
        page: 1,
        size: SEARCH_PERFORMANCE_DEFAULT_PAGE_SIZE,
      }),
    ],
  },
  component: SearchPerformanceRoute,
});

function SearchPerformanceRoute() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  return (
    <>
      <SearchPerformancePage
        projectId={projectId}
        search={search}
        onSearchChange={(update) => {
          void navigate({
            search: (prev) => ({ ...prev, ...update }),
            replace: true,
          });
        }}
      />
      <div className="px-4 pb-6 md:px-6">
        <div className="mx-auto max-w-7xl">
          <SavedRunsList
            projectId={projectId}
            kinds={["url_inspection", "ga4_landing_pages"]}
            renderLink={() => null}
          />
        </div>
      </div>
    </>
  );
}
