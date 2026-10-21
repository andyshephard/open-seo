import type { BillingCustomerContext } from "@/server/billing/subscription";
import { ResearchHistoryRepository as repo } from "../repositories/ResearchHistoryRepository";

// Capture records a lookup that has already been paid for (or served from
// cache), so it costs no credits. Rows are dated by the provider fetch, so
// re-recording a cached result rewrites the same row. It only records lookups
// made inside a verified project (`billingCustomer.projectId` is set by the
// project auth middleware), and a failed write is logged, never surfaced:
// history must not break the lookup.

function capturedOn(fetchedAt: string) {
  return fetchedAt.slice(0, 10);
}

async function capture(label: string, write: () => Promise<void>) {
  try {
    await write();
  } catch (error) {
    console.error(`research-history.${label} failed:`, error);
  }
}

export async function captureDomainOverview(
  billingCustomer: BillingCustomerContext,
  input: {
    domain: string;
    locationCode: number;
    languageCode: string;
    organicTraffic: number | null;
    organicKeywords: number | null;
    top3Keywords: number | null;
    top10Keywords: number | null;
    fetchedAt: string;
  },
) {
  const projectId = billingCustomer.projectId;
  if (!projectId) return;
  const { fetchedAt, ...metrics } = input;
  await capture("domain", () =>
    repo.upsertDomainSnapshot({
      ...metrics,
      projectId,
      capturedOn: capturedOn(fetchedAt),
      capturedAt: fetchedAt,
    }),
  );
}

export async function captureBacklinkSummary(
  billingCustomer: BillingCustomerContext,
  input: {
    domain: string;
    includeSubdomains: boolean;
    rank: number | null;
    backlinks: number | null;
    referringDomains: number | null;
    referringPages: number | null;
    brokenBacklinks: number | null;
    newBacklinks: number | null;
    lostBacklinks: number | null;
    newReferringDomains: number | null;
    lostReferringDomains: number | null;
    spamScore: number | null;
    fetchedAt: string;
  },
) {
  const projectId = billingCustomer.projectId;
  if (!projectId) return;
  const { fetchedAt, ...metrics } = input;
  await capture("backlinks", () =>
    repo.upsertBacklinkSnapshot({
      ...metrics,
      projectId,
      capturedOn: capturedOn(fetchedAt),
      capturedAt: fetchedAt,
    }),
  );
}

export async function captureKeywordMetrics(
  projectId: string,
  input: {
    locationCode: number;
    languageCode: string;
    rows: Array<{
      keyword: string;
      searchVolume: number | null;
      cpc: number | null;
      competition: number | null;
      keywordDifficulty: number | null;
    }>;
  },
  now = new Date(),
) {
  if (input.rows.length === 0) return;
  const capturedAt = now.toISOString();
  await capture("keywords", () =>
    repo.upsertKeywordSnapshots(
      input.rows.map((row) => ({
        projectId,
        keyword: row.keyword,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        searchVolume: row.searchVolume,
        cpc: row.cpc,
        competition: row.competition,
        keywordDifficulty: row.keywordDifficulty,
        capturedOn: capturedOn(capturedAt),
        capturedAt,
      })),
    ),
  );
}
