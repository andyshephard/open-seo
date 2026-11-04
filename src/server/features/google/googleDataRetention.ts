import { GoogleAccountService } from "@/server/features/google/GoogleAccountService";

// A grant gets a day to be bound to a project after the connect flow.
const UNUSED_GRANT_GRACE_MS = 24 * 60 * 60 * 1000;
// Each grant costs a token refresh and a revocation at Google plus a few
// queries. The daily cron has 15 minutes for all its jobs, so the purge stops
// starting new grants after this and the backlog continues the next day.
const PURGE_TIME_BUDGET_MS = 8 * 60 * 1000;

/**
 * Daily cron body: drops Google grants no project uses any more, as the
 * privacy policy promises. Cached Google reports (the dashboard's last-good
 * Search Console copy) are kept until their 90-day expiresAt: the daily cache
 * sweep (r2-cache-sweep.ts) deletes them once expired, and on Cloudflare the
 * bucket's 90-day `dataforseo-cache/` lifecycle rule is a backstop.
 * Disconnecting Search Console (or removing its Google account, or switching
 * the project to another property) deletes that cache and the stored Search
 * Console history at once; doing so for GA4 deletes the archived GA4 reports.
 * GA4 has no dashboard cache.
 */
export async function purgeUnusedGoogleData(now = new Date()) {
  const googleGrants = await GoogleAccountService.purgeUnusedGrants(
    new Date(now.getTime() - UNUSED_GRANT_GRACE_MS),
    now.getTime() + PURGE_TIME_BUDGET_MS,
  );
  return { googleGrants };
}
