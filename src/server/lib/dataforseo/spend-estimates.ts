import {
  AI_LIVE_RECORD_COST_USD,
  AI_RECORD_COST_USD,
} from "@/shared/ai-visibility";
import {
  costPerSerpAtDepth,
  serpKeywordCostMultiplier,
} from "@/shared/rank-tracking";

// The live endpoint's per-page rates. The app no longer posts live organic
// SERPs (reads and rank checks use the task queue), but the cap still has to
// hold an upper bound for any request core.ts sends, so these stay here.
const LIVE_BASE_PAGE_COST_USD = 0.002;
const LIVE_EXTRA_PAGE_COST_USD = 0.0015;
// A task posted with priority 2 bills at twice the standard-queue rate.
const TASK_PRIORITY_HIGH = 2;

// Upper-bound USD for one DataForSEO request, read from the wire request itself
// (path + posted tasks), for the monthly spend cap (spend-cap.ts). It is the
// amount held against the cap before the call; the call then settles on the
// `cost` DataForSEO reports. Overestimating only refuses a call slightly early
// near the cap; underestimating lets one call overshoot it by the difference.
//
// It works on the wire shape, not on the fetcher inputs pricing.ts prices, so
// it covers every request core.ts sends, including any endpoint added later
// (those get FALLBACK_TASK_USD per task until priced here). Kept free of the
// section fetchers: core.ts imports this module, and pricing.ts imports them.
// The rates mirror pricing.ts; spend-estimates.test.ts checks they stay at or
// above it.

/** Unpriced paid endpoint: per task, high on purpose. */
export const FALLBACK_TASK_USD = 0.1;

const LABS_TASK_USD = 0.012;
const LABS_ROW_USD = 0.00012;
const LABS_DEFAULT_ROWS = 100;
const GOOGLE_ADS_TASK_USD = 0.09;
const BACKLINKS_TASK_USD = 0.024;
const BACKLINKS_ROW_USD = 0.000036;
const BACKLINKS_DEFAULT_ROWS = 100;
// history: one row per day of the requested range, as pricing.ts prices it.
// Without a readable range, DataForSEO's default (from 2019-01-01) is several
// years of rows; this caps the guess at that.
const BACKLINKS_HISTORY_FALLBACK_ROWS = 3000;
const BUSINESS_LISTINGS_TASK_USD = 0.012;
const BUSINESS_LISTINGS_ROW_USD = 0.00036;
const MY_BUSINESS_INFO_USD = 0.0054;
const QUESTIONS_ANSWERS_PER_20_USD = 0.0054;
const REVIEWS_TASK_USD = 0.001;
const REVIEWS_PER_10_USD = 0.0015;
const EXTENDED_REVIEWS_PER_20_USD = 0.01;
const UPDATES_TASK_USD = 0.003;
const UPDATES_PER_10_USD = 0.0015;
const LIGHTHOUSE_USD = 0.005;
const LOCAL_SERP_PAGE_USD = 0.002;
const LLM_MENTIONS_TASK_USD = 0.1;
const LLM_MENTIONS_ROW_USD = 0.001;
const LLM_MENTIONS_DEFAULT_ROWS = 100;
const LLM_RESPONSE_USD: Record<
  string,
  { webSearch: number; noSearch: number }
> = {
  chat_gpt: { webSearch: 0.09, noSearch: 0.05 },
  claude: { webSearch: 0.18, noSearch: 0.08 },
  gemini: { webSearch: 0.11, noSearch: 0.05 },
  perplexity: { webSearch: 0.04, noSearch: 0.04 },
};
const LLM_RESPONSE_UNKNOWN_MODEL_USD = 0.18;

type Task = Record<string, unknown>;

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function listLength(value: unknown, fallback: number): number {
  return Array.isArray(value) && value.length > 0 ? value.length : fallback;
}

const DAY_MS = 86_400_000;

/** Days in the task's date_from..date_to (to defaults to today), inclusive. */
function backlinksHistoryRows(task: Task, today = new Date()): number {
  const from =
    typeof task.date_from === "string" ? Date.parse(task.date_from) : NaN;
  const to =
    typeof task.date_to === "string"
      ? Date.parse(task.date_to)
      : today.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from)
    return BACKLINKS_HISTORY_FALLBACK_ROWS;
  return Math.floor((to - from) / DAY_MS) + 1;
}

function isTask(value: unknown): value is Task {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tasksOf(body: unknown): Task[] {
  const list: unknown[] = Array.isArray(body) ? body : [body];
  return list.map((task) => (isTask(task) ? task : {}));
}

/** Requests DataForSEO never bills: reads of reference data and collection. */
function isFreePath(path: string): boolean {
  return (
    path.startsWith("/v3/appendix/") ||
    /\/(task_get|tasks_ready|tasks_fixed|id_list|errors)(\/|$)/.test(path) ||
    /\/(locations|languages|categories|models|filters|available_filters)(\/|$)/.test(
      path,
    )
  );
}

function serpOrganicUsd(task: Task, method: "live" | "queued"): number {
  const depth = Math.ceil(positive(task.depth, 10) / 10) * 10;
  const keyword = typeof task.keyword === "string" ? task.keyword : "";
  const pages = depth / 10;
  const perPage =
    method === "queued"
      ? costPerSerpAtDepth(depth) *
        (task.priority === TASK_PRIORITY_HIGH ? 2 : 1)
      : LIVE_BASE_PAGE_COST_USD + (pages - 1) * LIVE_EXTRA_PAGE_COST_USD;
  const page = perPage * serpKeywordCostMultiplier(keyword);
  // The async AI Overview load bills as much again as the first page.
  return task.load_async_ai_overview === true
    ? page +
        (method === "queued" ? costPerSerpAtDepth(10) : LIVE_BASE_PAGE_COST_USD)
    : page;
}

function taskUsd(path: string, task: Task): number {
  if (path.startsWith("/v3/dataforseo_labs/")) {
    const rows = /keyword_overview|search_volume|bulk_|keyword_difficulty/.test(
      path,
    )
      ? listLength(task.keywords, 1)
      : /domain_rank_overview/.test(path)
        ? 1
        : positive(task.limit, LABS_DEFAULT_ROWS);
    const clickstream = task.include_clickstream_data === true ? 2 : 1;
    return (LABS_TASK_USD + rows * LABS_ROW_USD) * clickstream;
  }
  if (path.startsWith("/v3/keywords_data/")) return GOOGLE_ADS_TASK_USD;
  if (path.startsWith("/v3/backlinks/")) {
    const rows = path.startsWith("/v3/backlinks/history/")
      ? backlinksHistoryRows(task)
      : /\/summary\//.test(path)
        ? 1
        : positive(task.limit, BACKLINKS_DEFAULT_ROWS);
    return BACKLINKS_TASK_USD + rows * BACKLINKS_ROW_USD;
  }
  if (path.startsWith("/v3/serp/")) {
    if (path.includes("/maps/")) return LOCAL_SERP_PAGE_USD;
    if (path.includes("/local_finder/"))
      return Math.ceil(positive(task.depth, 20) / 10) * LOCAL_SERP_PAGE_USD;
    return serpOrganicUsd(
      task,
      path.includes("/task_post") ? "queued" : "live",
    );
  }
  if (path.startsWith("/v3/on_page/lighthouse/")) return LIGHTHOUSE_USD;
  if (path.startsWith("/v3/business_data/")) {
    const depth = (fallback: number) => positive(task.depth, fallback);
    if (path.includes("/business_listings/search"))
      return (
        BUSINESS_LISTINGS_TASK_USD +
        positive(task.limit, 100) * BUSINESS_LISTINGS_ROW_USD
      );
    if (path.includes("/my_business_info/")) return MY_BUSINESS_INFO_USD;
    if (path.includes("/questions_and_answers/"))
      return Math.ceil(depth(20) / 20) * QUESTIONS_ANSWERS_PER_20_USD;
    if (path.includes("/extended_reviews/"))
      return Math.ceil(depth(20) / 20) * EXTENDED_REVIEWS_PER_20_USD;
    if (path.includes("/reviews/"))
      return REVIEWS_TASK_USD + Math.ceil(depth(20) / 10) * REVIEWS_PER_10_USD;
    if (path.includes("/my_business_updates/"))
      return UPDATES_TASK_USD + Math.ceil(depth(20) / 10) * UPDATES_PER_10_USD;
    return FALLBACK_TASK_USD;
  }
  if (path.startsWith("/v3/ai_optimization/llm_mentions/")) {
    return path.includes("/search/")
      ? LLM_MENTIONS_TASK_USD +
          positive(task.limit, LLM_MENTIONS_DEFAULT_ROWS) * LLM_MENTIONS_ROW_USD
      : LLM_MENTIONS_TASK_USD + LLM_MENTIONS_ROW_USD;
  }
  const llmResponse = /^\/v3\/ai_optimization\/([^/]+)\/llm_responses\//.exec(
    path,
  );
  if (llmResponse) {
    const price = LLM_RESPONSE_USD[llmResponse[1]];
    if (!price) return LLM_RESPONSE_UNKNOWN_MODEL_USD;
    return task.web_search === false ? price.noSearch : price.webSearch;
  }
  if (/^\/v3\/ai_optimization\/[^/]+\/llm_scraper\//.test(path))
    return path.includes("/task_post")
      ? AI_RECORD_COST_USD
      : AI_LIVE_RECORD_COST_USD;
  return FALLBACK_TASK_USD;
}

/**
 * USD upper bound for one request. 0 for requests DataForSEO does not bill
 * (GETs, collection, reference data, the sandbox host).
 */
export function estimateDataforseoRequestUsd(input: {
  method: "GET" | "POST";
  path: string;
  body: unknown;
  sandbox?: boolean;
}): number {
  if (input.sandbox || input.method === "GET") return 0;
  const path = input.path.split("?")[0];
  if (isFreePath(path)) return 0;
  return tasksOf(input.body).reduce(
    (sum, task) => sum + taskUsd(path, task),
    0,
  );
}
