import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/client/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import { Switch } from "@/client/components/ui/switch";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  captureResearchSnapshotNow,
  getResearchSnapshotSchedule,
  setResearchSnapshotSchedule,
} from "@/serverFunctions/researchHistory";
import type { ResearchSnapshotInterval } from "@/types/schemas/researchHistory";

const INTERVAL_ITEMS = [
  { value: "off", label: "Off" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
] as const;

export function ResearchSnapshotScheduleCard({
  projectId,
}: {
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const scheduleQuery = useQuery({
    queryKey: ["researchSnapshotSchedule", projectId],
    queryFn: () => getResearchSnapshotSchedule({ data: { projectId } }),
  });
  const schedule = scheduleQuery.data ?? null;
  const includeKeywords = schedule?.includeKeywords ?? true;

  const saveMutation = useMutation({
    mutationFn: (input: {
      interval: ResearchSnapshotInterval | null;
      includeKeywords: boolean;
    }) => setResearchSnapshotSchedule({ data: { projectId, ...input } }),
    onSuccess: (next) => {
      queryClient.setQueryData(["researchSnapshotSchedule", projectId], next);
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Could not save schedule.")),
  });
  const captureMutation = useMutation({
    mutationFn: () =>
      captureResearchSnapshotNow({ data: { projectId, includeKeywords } }),
    onSuccess: (result) => {
      setConfirming(false);
      void queryClient.invalidateQueries({
        queryKey: ["researchHistory", projectId],
      });
      if (result.failed > 0)
        toast.warning(
          `Snapshot saved with ${result.failed} of ${result.total} lookups failing.`,
        );
      else
        toast.success(`Snapshot saved for ${result.domains.length} domains.`);
    },
    onError: (error) => {
      setConfirming(false);
      toast.error(getStandardErrorMessage(error, "Snapshot failed."));
    },
  });

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">Scheduled snapshots</CardTitle>
        <CardDescription>
          Fetches your domain and every saved competitor: domain overview,
          ranked keywords and top pages, backlinks summary, backlinks, referring
          domains and linked pages (plus saved keyword metrics). Each result
          opens on its own page (Domain Overview, Backlinks, Keyword Research).
          Snapshot now always buys fresh data; the schedule reuses only data
          bought the same day. Uses data credits.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        <Select
          items={INTERVAL_ITEMS}
          value={schedule?.interval ?? "off"}
          onValueChange={(value) =>
            saveMutation.mutate({
              interval:
                value === "weekly" || value === "monthly" ? value : null,
              includeKeywords,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Snapshot schedule">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERVAL_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={includeKeywords}
            disabled={!schedule || saveMutation.isPending}
            onCheckedChange={(checked) =>
              schedule &&
              saveMutation.mutate({
                interval:
                  schedule.interval === "monthly" ? "monthly" : "weekly",
                includeKeywords: checked,
              })
            }
          />
          Refresh saved keyword metrics too
        </label>
        <div className="ml-auto flex items-center gap-2">
          {confirming ? (
            <>
              <span className="text-xs text-muted-foreground">
                Buys fresh data for every domain now.
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={captureMutation.isPending}
                onClick={() => captureMutation.mutate()}
              >
                {captureMutation.isPending ? "Capturing…" : "Confirm"}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setConfirming(true)}>
              Snapshot now
            </Button>
          )}
        </div>
        {schedule ? (
          <p className="w-full text-xs text-muted-foreground">
            Next snapshot {new Date(schedule.nextCheckAt).toLocaleString()}
            {schedule.lastCheckedAt
              ? ` · last ${new Date(schedule.lastCheckedAt).toLocaleString()}`
              : ""}
            {schedule.lastSkipReason ? ` · ${schedule.lastSkipReason}` : ""}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
