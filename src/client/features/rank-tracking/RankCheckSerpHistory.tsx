import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import {
  getRankCheckSerp,
  listResearchArchive,
} from "@/serverFunctions/researchHistory";
import { rankCheckSerpParamsSchema } from "@/types/schemas/researchHistory";

function parseParams(params: string) {
  try {
    const parsed = rankCheckSerpParamsSchema.safeParse(JSON.parse(params));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The full Google results page saved by each check of this keyword. */
export function RankCheckSerpHistory({
  projectId,
  configId,
  trackingKeywordId,
  keyword,
  domain,
}: {
  projectId: string;
  configId: string;
  trackingKeywordId: string;
  keyword: string;
  domain: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listQuery = useQuery({
    queryKey: ["rankCheckSerps", projectId, keyword],
    queryFn: () =>
      listResearchArchive({
        data: {
          projectId,
          kinds: ["rank_check_serp"],
          target: keyword,
          limit: 200,
        },
      }),
  });
  const checks = (listQuery.data?.entries ?? []).flatMap((entry) => {
    const params = parseParams(entry.params);
    return params?.configId === configId &&
      params.trackingKeywordId === trackingKeywordId
      ? [{ id: entry.id, fetchedAt: entry.fetchedAt, device: params.device }]
      : [];
  });
  const activeId = selectedId ?? checks[0]?.id ?? null;
  const serpQuery = useQuery({
    enabled: activeId != null,
    queryKey: ["rankCheckSerp", projectId, activeId],
    queryFn: () =>
      getRankCheckSerp({ data: { projectId, id: activeId ?? "" } }),
    staleTime: Infinity,
  });

  if (checks.length === 0) return null;
  const items = checks.map((check) => ({
    value: check.id,
    label: `${new Date(check.fetchedAt).toLocaleString()} · ${check.device}`,
  }));
  const own = domain.toLowerCase();
  const organic = (serpQuery.data?.items ?? []).filter(
    (item) => item.type === "organic",
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Saved results pages</h3>
        <Select
          items={items}
          value={activeId}
          onValueChange={(value) =>
            typeof value === "string" && setSelectedId(value)
          }
        >
          <SelectTrigger size="sm" aria-label="Rank check">
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
      </div>
      <div className="max-h-72 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {organic.map((item, index) => {
              const itemDomain = item.domain?.toLowerCase() ?? "";
              const isOwn =
                itemDomain === own || itemDomain.endsWith(`.${own}`);
              return (
                <TableRow
                  key={`${item.url ?? ""}-${index}`}
                  className={isOwn ? "bg-primary/5" : undefined}
                >
                  <TableCell className="tabular-nums">
                    {item.rankGroup ?? "—"}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">
                      {item.title ?? item.domain}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {item.url}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
