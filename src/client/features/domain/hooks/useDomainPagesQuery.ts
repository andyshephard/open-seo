import { useQuery } from "@tanstack/react-query";
import { useArchiveView } from "@/client/features/research-history/archiveAsOf";
import { getDomainPagesPage } from "@/serverFunctions/domain";
import { toPageSortMode } from "@/client/features/domain/utils";
import type { ResearchScope } from "@/shared/researchScope";
import type {
  DomainSortMode,
  PagesFilterValues,
  SortOrder,
} from "@/client/features/domain/types";

type DomainPagesQueryInput = {
  projectId: string;
  domain: string;
  scope: ResearchScope;
  locationCode: number | undefined;
  page: number;
  pageSize: number;
  sortMode: DomainSortMode;
  sortOrder: SortOrder;
  appliedFilters: PagesFilterValues;
  enabled: boolean;
};

export function useDomainPagesQuery(input: DomainPagesQueryInput) {
  const pageSortMode = toPageSortMode(input.sortMode);
  const { asOf, refresh, refreshNonce } = useArchiveView();
  return useQuery({
    enabled: input.enabled && Boolean(input.domain),
    queryKey: [
      "domain-pages",
      input.projectId,
      input.domain,
      input.scope,
      input.locationCode,
      input.page,
      input.pageSize,
      pageSortMode,
      input.sortOrder,
      asOf,
      refreshNonce,
      input.appliedFilters,
    ],
    queryFn: () =>
      getDomainPagesPage({
        data: {
          projectId: input.projectId,
          domain: input.domain,
          scope: input.scope,
          locationCode: input.locationCode,
          page: input.page,
          pageSize: input.pageSize,
          sortMode: pageSortMode,
          sortOrder: input.sortOrder,
          asOf,
          refresh,
          filters: input.appliedFilters,
        },
      }),
    staleTime: 60_000,
  });
}
