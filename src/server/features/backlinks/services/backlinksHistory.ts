import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  archiveLookup,
  archiveParams,
} from "@/server/features/research-history/services/researchArchive";
import { captureBacklinkSummary } from "@/server/features/research-history/services/researchHistoryCapture";
import { normalizeBacklinksTarget } from "@/server/lib/dataforseoBacklinksTarget";
import type { BacklinksLookupInput } from "@/types/schemas/backlinks";
import type { BacklinksOverviewResult } from "./backlinksOverviewSchema";

// Research history for backlinks lookups: every fresh result is archived, and
// whole-domain overviews also record a dated snapshot of their totals.

export function archiveBacklinks(
  billingCustomer: BillingCustomerContext,
  {
    kind,
    viewKey,
    input,
    fetchedAt,
    payload,
  }: {
    kind:
      | "backlinks_overview"
      | "backlinks_rows"
      | "backlinks_referring_domains"
      | "backlinks_top_pages";
    viewKey: string;
    input: BacklinksLookupInput;
    fetchedAt: string;
    payload: unknown;
  },
) {
  return archiveLookup(billingCustomer, {
    kind,
    target: normalizeBacklinksTarget(input.target, { scope: input.scope })
      .displayTarget,
    viewKey,
    params: archiveParams(input),
    fetchedAt,
    payload,
  });
}

// Only whole-domain profiles build history: page and subfolder lookups are not
// comparable with the domain series.
export function recordBacklinkSummary(
  billingCustomer: BillingCustomerContext,
  overview: BacklinksOverviewResult,
) {
  if (overview.scope !== "domain" && overview.scope !== "subdomains")
    return Promise.resolve();
  const { summary } = overview;
  return captureBacklinkSummary(billingCustomer, {
    domain: overview.target,
    includeSubdomains: overview.scope === "subdomains",
    rank: summary.rank,
    backlinks: summary.backlinks,
    referringDomains: summary.referringDomains,
    referringPages: summary.referringPages,
    brokenBacklinks: summary.brokenBacklinks,
    newBacklinks: summary.newBacklinks,
    lostBacklinks: summary.lostBacklinks,
    newReferringDomains: summary.newReferringDomains,
    lostReferringDomains: summary.lostReferringDomains,
    spamScore: summary.targetSpamScore,
    fetchedAt: overview.fetchedAt,
  });
}
