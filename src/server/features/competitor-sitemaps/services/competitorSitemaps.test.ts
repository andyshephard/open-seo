import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { buildBillingCustomer } from "@/server/mcp/context";
import { makeToolContext } from "@/server/mcp/tools/tool-test-support";
import { diffCompetitorSitemaps } from "./competitorSitemaps";

const mocks = vi.hoisted(() => ({
  publicFetch: vi.fn<(url: string) => Promise<Response>>(),
  archiveLookup: vi.fn(),
  readArchivedView: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/public-fetch", () => ({
  publicFetch: mocks.publicFetch,
}));
vi.mock("@/server/lib/audit/url-policy", () => ({
  // Blocks private hosts like the real policy; everything else is public.
  normalizeAndValidateStartUrl: async (input: string) => {
    const url = new URL(input.startsWith("http") ? input : `https://${input}`);
    if (url.hostname === "169.254.169.254")
      throw new AppError("CRAWL_TARGET_BLOCKED");
    return url.toString();
  },
}));
vi.mock("@/server/features/research-history/services/researchArchive", () => ({
  archiveLookup: mocks.archiveLookup,
  readArchivedView: mocks.readArchivedView,
}));
vi.mock(
  "@/server/features/project-context/services/ProjectContextService",
  () => ({ ProjectContextService: { getProjectContext: vi.fn() } }),
);

const { baseUrl: _baseUrl, ...auth } = makeToolContext().auth;
const billing = buildBillingCustomer(auth, "p", "mcp");
const input = { projectId: "p", domains: ["a.com"], sinceDays: 7 };

function respond(routes: Record<string, Response | (() => Response)>) {
  mocks.publicFetch.mockImplementation(async (url) => {
    const route = routes[url];
    if (!route) return new Response("", { status: 404 });
    return typeof route === "function" ? route() : route;
  });
}

beforeEach(() => {
  mocks.archiveLookup.mockResolvedValue(true);
  mocks.readArchivedView.mockRejectedValue(new AppError("NOT_FOUND"));
});

describe("diffCompetitorSitemaps", () => {
  it("reads a sitemap listed in robots.txt and stores the first snapshot", async () => {
    respond({
      "https://a.com/robots.txt": new Response("Sitemap: https://a.com/s.xml"),
      "https://a.com/s.xml": new Response(
        "<urlset><url><loc>https://a.com/blog/x</loc><lastmod>2999-01-01</lastmod></url></urlset>",
      ),
    });
    const { results } = await diffCompetitorSitemaps(input, billing);
    expect(results[0]).toMatchObject({
      ok: true,
      totalUrls: 1,
      firstRun: true,
      newUrls: null,
      recentlyModified: { count: 1 },
    });
    expect(mocks.archiveLookup).toHaveBeenCalledTimes(1);
  });

  it("refuses a gzip bomb instead of inflating it", async () => {
    // 12 MB of zeros gzips to a few KB but is over the 10 MB text cap.
    const bomb = gzipSync(Buffer.alloc(12_000_000));
    expect(bomb.byteLength).toBeLessThan(100_000);
    respond({
      "https://a.com/robots.txt": new Response(""),
      "https://a.com/sitemap.xml": new Response(bomb),
    });
    const { results } = await diffCompetitorSitemaps(input, billing);
    expect(results[0]).toMatchObject({ ok: false });
    expect(mocks.archiveLookup).not.toHaveBeenCalled();
  });

  it("re-validates redirects and never fetches a blocked target", async () => {
    respond({
      "https://a.com/robots.txt": () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        }),
    });
    const { results } = await diffCompetitorSitemaps(input, billing);
    expect(results[0]).toMatchObject({ ok: false });
    expect(mocks.publicFetch.mock.calls.map(([url]) => url)).not.toContain(
      "http://169.254.169.254/latest",
    );
  });

  it("flags the diff as partial when the previous snapshot was truncated", async () => {
    mocks.readArchivedView.mockResolvedValue({
      fetchedAt: "2026-11-01T00:00:00.000Z",
      truncated: true,
      urls: [["https://a.com/old", null]],
    });
    respond({
      "https://a.com/robots.txt": new Response("Sitemap: https://a.com/s.xml"),
      "https://a.com/s.xml": new Response(
        "<urlset><url><loc>https://a.com/new</loc></url></urlset>",
      ),
    });
    const { results } = await diffCompetitorSitemaps(input, billing);
    expect(results[0]).toMatchObject({
      diffPartial: true,
      removedUrls: null,
      newUrls: { count: 1 },
    });
  });
});
