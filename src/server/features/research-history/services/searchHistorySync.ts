import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { Ga4ReportingService } from "@/server/features/ga4/services/Ga4ReportingService";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { createGscClient } from "@/server/lib/gscClient";
import { SearchHistoryRepository as repo } from "../repositories/SearchHistoryRepository";
import { ResearchArchiveRepository } from "../repositories/ResearchArchiveRepository";
import { archiveLookup } from "./researchArchive";

// Daily copy of Search Console and GA4 into OpenSEO, so history outlives the
// providers' windows (16 months for Search Console) and agents read it free.
// Each run picks up from the last stored day; the first run backfills.

// Search Console finalizes a day after about three days.
const GSC_FINAL_LAG_DAYS = 3;
const GSC_TOTALS_BACKFILL_DAYS = 486;
// Query/page rows are one request per day per dimension, so backfill and
// catch-up are bounded per run; the next run continues.
const ROW_BACKFILL_DAYS = 30;
const MAX_ROW_DAYS_PER_RUN = 30;
const TOP_ROWS_PER_DAY = 1000;
const GA4_LAG_DAYS = 1;
const GA4_BACKFILL_DAYS = 30;
const RUN_DEADLINE_MS = 10 * 60_000;

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function syncSearchConsole(
  connection: Awaited<
    ReturnType<typeof GscConnectionRepository.listActive>
  >[number]["connection"],
  deadline: number,
) {
  const { projectId, siteUrl } = connection;
  const client = createGscClient({
    userId: connection.connectedByUserId,
    gscAccountId: connection.gscAccountId ?? undefined,
  });
  const end = addDays(today(), -GSC_FINAL_LAG_DAYS);

  const lastTotals = await repo.latestTotalsDate(projectId);
  const totalsStart = lastTotals
    ? addDays(lastTotals, 1)
    : addDays(end, 1 - GSC_TOTALS_BACKFILL_DAYS);
  if (totalsStart <= end) {
    const rows = await client.querySearchAnalytics(siteUrl, {
      startDate: totalsStart,
      endDate: end,
      dimensions: ["date"],
      rowLimit: 25000,
    });
    await repo.upsertTotals(
      rows.flatMap((row) =>
        row.keys?.[0]
          ? [
              {
                projectId,
                date: row.keys[0],
                clicks: row.clicks,
                impressions: row.impressions,
                ctr: row.ctr,
                position: row.position,
              },
            ]
          : [],
      ),
    );
  }

  const lastRows = await repo.latestRowsDate(projectId);
  const rowsStart = lastRows
    ? addDays(lastRows, 1)
    : addDays(end, 1 - ROW_BACKFILL_DAYS);
  for (const date of daysBetween(rowsStart, end).slice(
    0,
    MAX_ROW_DAYS_PER_RUN,
  )) {
    if (Date.now() >= deadline) return;
    for (const dimension of ["query", "page"] as const) {
      const rows = await client.querySearchAnalytics(siteUrl, {
        startDate: date,
        endDate: date,
        dimensions: [dimension],
        rowLimit: TOP_ROWS_PER_DAY,
      });
      await repo.upsertRows(
        rows.flatMap((row) =>
          row.keys?.[0]
            ? [
                {
                  projectId,
                  date,
                  dimension,
                  value: row.keys[0],
                  clicks: row.clicks,
                  impressions: row.impressions,
                  ctr: row.ctr,
                  position: row.position,
                },
              ]
            : [],
        ),
      );
    }
  }
}

async function syncGa4LandingPages(
  connection: Awaited<
    ReturnType<typeof Ga4ConnectionRepository.listActive>
  >[number]["connection"],
  organizationId: string,
  deadline: number,
) {
  const { projectId } = connection;
  const customer = {
    organizationId,
    userId: "system",
    userEmail: "system@openseo.so",
    projectId,
    origin: "schedule" as const,
  };
  const end = addDays(today(), -GA4_LAG_DAYS);
  const [latest] = await ResearchArchiveRepository.listEntries({
    projectId,
    kinds: ["ga4_landing_pages"],
    limit: 1,
  });
  const start = latest
    ? addDays(latest.fetchedAt.slice(0, 10), 1)
    : addDays(end, 1 - GA4_BACKFILL_DAYS);
  for (const date of daysBetween(start, end).slice(0, GA4_BACKFILL_DAYS)) {
    if (Date.now() >= deadline) return;
    const report = await Ga4ReportingService.runReport({
      projectId,
      kind: "landing_pages",
      channel: "organic_search",
      startDate: date,
      endDate: date,
      limit: 1000,
    });
    await archiveLookup(customer, {
      kind: "ga4_landing_pages",
      target: "organic landing pages",
      viewKey: `ga4:landing-pages:${projectId}`,
      params: { date },
      // Dated by the report day, so "as of" a day reopens that day.
      fetchedAt: `${date}T12:00:00.000Z`,
      payload: report,
    });
  }
}

/** Daily cron body: sync every connected project, one failure at a time. */
export async function runDailySearchHistorySync() {
  const deadline = Date.now() + RUN_DEADLINE_MS;
  for (const { connection } of await GscConnectionRepository.listActive()) {
    if (Date.now() >= deadline) break;
    try {
      await syncSearchConsole(connection, deadline);
    } catch (error) {
      console.error("[search-history] Search Console sync failed", {
        projectId: connection.projectId,
        error,
      });
    }
  }
  for (const {
    connection,
    organizationId,
  } of await Ga4ConnectionRepository.listActive()) {
    if (Date.now() >= deadline) break;
    try {
      await syncGa4LandingPages(connection, organizationId, deadline);
    } catch (error) {
      console.error("[search-history] GA4 sync failed", {
        projectId: connection.projectId,
        error,
      });
    }
  }
}
