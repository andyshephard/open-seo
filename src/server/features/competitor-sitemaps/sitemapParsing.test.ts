import { describe, expect, it } from "vitest";
import {
  diffSnapshots,
  firstPathSegment,
  groupByFirstSegment,
  normalizeSitemapUrl,
  parseRobotsSitemaps,
  parseSitemapXml,
  recentlyModified,
  type SnapshotUrl,
} from "./sitemapParsing";

const INDEX = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://a.com/sitemap-blog.xml</loc><lastmod>2026-11-01</lastmod></sitemap>
  <sitemap><loc>https://a.com/sitemap-pages.xml.gz</loc></sitemap>
</sitemapindex>`;

const URLSET = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://a.com/blog/one?a=1&amp;b=2</loc>
    <lastmod>2026-11-10T08:00:00+00:00</lastmod>
    <image:image><image:loc>https://a.com/img.png</image:loc></image:image>
  </url>
  <url><loc><![CDATA[https://a.com/review/two]]></loc></url>
</urlset>`;

describe("parseSitemapXml", () => {
  it("reads a sitemap index", () => {
    expect(parseSitemapXml(INDEX)).toEqual({
      kind: "index",
      entries: [
        { loc: "https://a.com/sitemap-blog.xml", lastmod: "2026-11-01" },
        { loc: "https://a.com/sitemap-pages.xml.gz", lastmod: null },
      ],
    });
  });

  it("reads a urlset, decoding entities and CDATA and ignoring image:loc", () => {
    expect(parseSitemapXml(URLSET)).toEqual({
      kind: "urlset",
      entries: [
        {
          loc: "https://a.com/blog/one?a=1&b=2",
          lastmod: "2026-11-10T08:00:00+00:00",
        },
        { loc: "https://a.com/review/two", lastmod: null },
      ],
    });
  });
});

describe("parseRobotsSitemaps", () => {
  it("lists Sitemap lines case-insensitively, once each", () => {
    const robots =
      "User-agent: *\nDisallow: /x\nSitemap: https://a.com/s.xml\nsitemap:https://a.com/t.xml\r\nSitemap: https://a.com/s.xml";
    expect(parseRobotsSitemaps(robots)).toEqual([
      "https://a.com/s.xml",
      "https://a.com/t.xml",
    ]);
  });
});

describe("normalizeSitemapUrl", () => {
  it("lowercases the host and drops fragment and trailing slash", () => {
    expect(normalizeSitemapUrl("https://A.com/Blog/#x")).toBe(
      "https://a.com/Blog",
    );
  });
});

describe("diffSnapshots", () => {
  const previous: SnapshotUrl[] = [
    ["https://a.com/keep", "2026-01-01"],
    ["https://a.com/gone", null],
    ["https://a.com/refresh", "2026-01-01"],
    ["https://a.com/same-instant", "2026-01-01T00:00:00Z"],
  ];
  const current: SnapshotUrl[] = [
    ["https://a.com/keep", "2026-01-01"],
    ["https://a.com/refresh", "2026-02-01"],
    ["https://a.com/same-instant", "2026-01-01T00:00:00+00:00"],
    ["https://a.com/blog/new", null],
  ];

  it("finds new, removed and refreshed URLs", () => {
    expect(diffSnapshots(previous, current)).toEqual({
      added: ["https://a.com/blog/new"],
      removed: ["https://a.com/gone"],
      refreshed: ["https://a.com/refresh"],
    });
  });
});

describe("grouping and recency", () => {
  it("groups by first path segment", () => {
    expect(firstPathSegment("https://a.com/")).toBe("/");
    expect(firstPathSegment("https://a.com/about")).toBe("/");
    expect(
      groupByFirstSegment([
        "https://a.com/blog/1",
        "https://a.com/blog/2",
        "https://a.com/review/x",
      ]).map(({ segment, count }) => [segment, count]),
    ).toEqual([
      ["/blog/", 2],
      ["/review/", 1],
    ]);
  });

  it("counts URLs modified inside the window", () => {
    const now = Date.parse("2026-11-18T00:00:00Z");
    expect(
      recentlyModified(
        [
          ["https://a.com/new", "2026-11-15"],
          ["https://a.com/old", "2026-10-01"],
          ["https://a.com/none", null],
        ],
        7,
        now,
      ),
    ).toEqual(["https://a.com/new"]);
  });
});
