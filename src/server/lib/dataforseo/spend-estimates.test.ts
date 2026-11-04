import { describe, expect, it } from "vitest";
import { dataforseoPricing } from "@/server/lib/dataforseo/pricing";
import {
  estimateDataforseoRequestUsd,
  FALLBACK_TASK_USD,
} from "@/server/lib/dataforseo/spend-estimates";

const post = (path: string, body: unknown) =>
  estimateDataforseoRequestUsd({ method: "POST", path, body });

/** pricing.ts's estimate for a fetcher input that sets only the priced fields. */
function pricedAt<I>(estimate: (input: I) => number, input: Partial<I>) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each estimator reads only the fields given
  return estimate(input as I);
}

describe("DataForSEO spend estimates", () => {
  it("prices requests DataForSEO never bills at zero", () => {
    expect(
      estimateDataforseoRequestUsd({
        method: "GET",
        path: "/v3/serp/google/organic/task_get/advanced/abc",
        body: undefined,
      }),
    ).toBe(0);
    expect(post("/v3/appendix/user_data", [])).toBe(0);
    expect(post("/v3/serp/google/locations/us", [])).toBe(0);
    expect(post("/v3/ai_optimization/chat_gpt/llm_responses/models", [])).toBe(
      0,
    );
    expect(
      estimateDataforseoRequestUsd({
        method: "POST",
        path: "/v3/serp/google/organic/live/advanced",
        body: [{ keyword: "seo", depth: 10 }],
        sandbox: true,
      }),
    ).toBe(0);
  });

  it("charges every posted task", () => {
    const one = post("/v3/serp/google/organic/task_post", [
      { keyword: "a", depth: 100 },
    ]);
    const three = post("/v3/serp/google/organic/task_post", [
      { keyword: "a", depth: 100 },
      { keyword: "b", depth: 100 },
      { keyword: "c", depth: 100 },
    ]);
    expect(three).toBeCloseTo(one * 3, 10);
  });

  it("prices backlinks history by the days in its range", () => {
    const history = (task: Record<string, unknown>) =>
      post("/v3/backlinks/history/live", [task]);
    expect(
      history({
        target: "chunks.app",
        date_from: "2026-10-01",
        date_to: "2026-10-30",
      }),
    ).toBeCloseTo(0.024 + 30 * 0.000036, 10);
    expect(
      history({
        target: "chunks.app",
        date_from: "2025-11-01",
        date_to: "2026-10-31",
      }),
    ).toBeCloseTo(
      pricedAt(dataforseoPricing.backlinks.history, {
        dateFrom: "2025-11-01",
        dateTo: "2026-10-31",
      }),
      10,
    );
    // No readable range: DataForSEO's default reaches back years.
    expect(history({ target: "chunks.app" })).toBeCloseTo(
      0.024 + 3000 * 0.000036,
      10,
    );
  });

  it("prices an endpoint it does not know high", () => {
    expect(post("/v3/content_analysis/search/live", [{}, {}])).toBe(
      2 * FALLBACK_TASK_USD,
    );
  });

  // The wire estimate must never fall below pricing.ts, which the hosted
  // billing reserves on and which is calibrated against real bills.
  it.each([
    [
      "related keywords",
      post("/v3/dataforseo_labs/google/related_keywords/live", [
        { keyword: "seo", limit: 300, include_clickstream_data: true },
      ]),
      pricedAt(dataforseoPricing.keywords.related, {
        keyword: "seo",
        limit: 300,
        includeClickstreamData: true,
      }),
    ],
    [
      "keyword overview",
      post("/v3/dataforseo_labs/google/keyword_overview/live", [
        { keywords: ["a", "b", "c"] },
      ]),
      pricedAt(dataforseoPricing.labs.keywordOverview, {
        keywords: ["a", "b", "c"],
      }),
    ],
    [
      "domain rank overview",
      post("/v3/dataforseo_labs/google/domain_rank_overview/live", [
        { target: "chunks.app" },
      ]),
      pricedAt(dataforseoPricing.domain.rankOverview, {}),
    ],
    [
      "ranked keywords",
      post("/v3/dataforseo_labs/google/ranked_keywords/live", [
        { target: "chunks.app", limit: 500 },
      ]),
      pricedAt(dataforseoPricing.domain.rankedKeywords, { limit: 500 }),
    ],
    [
      "backlinks summary",
      post("/v3/backlinks/summary/live", [{ target: "chunks.app" }]),
      pricedAt(dataforseoPricing.backlinks.summary, {}),
    ],
    [
      "referring domains",
      post("/v3/backlinks/referring_domains/live", [
        { target: "chunks.app", limit: 250 },
      ]),
      pricedAt(dataforseoPricing.backlinks.referringDomains, { limit: 250 }),
    ],
    [
      "live SERP at depth 30",
      post("/v3/serp/google/organic/live/advanced", [
        { keyword: "audio stories", depth: 30 },
      ]),
      pricedAt(dataforseoPricing.serp.live, {
        keyword: "audio stories",
        depth: 30,
      }),
    ],
    [
      "Google Ads search volume",
      post("/v3/keywords_data/google_ads/search_volume/live", [
        { keywords: ["a"] },
      ]),
      pricedAt(dataforseoPricing.keywords.adsSearchVolume, {}),
    ],
    [
      "Lighthouse",
      post("/v3/on_page/lighthouse/live/json", [{ url: "https://chunks.app" }]),
      pricedAt(dataforseoPricing.lighthouse.live, {}),
    ],
    [
      "LLM mentions search",
      post("/v3/ai_optimization/llm_mentions/search/live", [{ limit: 50 }]),
      pricedAt(dataforseoPricing.aiSearch.mentionsSearch, { limit: 50 }),
    ],
    [
      "LLM response with web search",
      post("/v3/ai_optimization/claude/llm_responses/live", [
        { web_search: true },
      ]),
      pricedAt(dataforseoPricing.aiSearch.llmResponse, {
        modelSlug: "claude",
        webSearch: true,
      }),
    ],
    [
      "AI Overview tracking, live",
      post("/v3/serp/google/organic/live/advanced", [
        { keyword: "seo", depth: 10, load_async_ai_overview: true },
      ]),
      pricedAt(dataforseoPricing.aiSearch.trackingLive, {}),
    ],
  ])("covers pricing.ts for %s", (_name, wire, priced) => {
    expect(wire).toBeGreaterThanOrEqual(priced - 1e-12);
  });
});
