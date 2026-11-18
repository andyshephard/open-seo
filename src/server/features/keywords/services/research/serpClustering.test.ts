import { describe, expect, it } from "vitest";
import {
  classifySerpPageType,
  clusterKeywordsBySerp,
  normalizeSerpUrl,
  type ClusterInput,
} from "./serpClustering";

function serp(
  keyword: string,
  volume: number | null,
  urls: string[],
): ClusterInput {
  return {
    keyword,
    volume,
    results: urls.map((url, index) => ({
      url,
      title: "A post",
      domain: new URL(url).hostname,
      position: index + 1,
    })),
  };
}

const listicle = (host: string) => ({
  url: `https://${host}/best-apps`,
  title: "10 best apps",
  domain: host,
});
const own = (path: string) => `https://www.mine.com/${path}`;

const pages = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `https://${prefix}${i}.com/post`);

describe("normalizeSerpUrl", () => {
  it("drops scheme, www, query, fragment and trailing slash", () => {
    expect(normalizeSerpUrl("HTTPS://WWW.Example.com/A/b/?x=1#top")).toBe(
      "example.com/A/b",
    );
  });
});

describe("classifySerpPageType", () => {
  it.each([
    ["https://www.reddit.com/r/x/comments/1", "Best apps?", "forum"],
    ["https://youtube.com/watch?v=1", "How to", "video"],
    ["https://a.com/docs/start", "Start", "docs"],
    ["https://a.com/blog/p", "10 best study apps", "listicle"],
    ["https://a.com/vs", "Notion alternatives", "listicle"],
    ["https://a.com/iq", "Free online IQ test", "tool"],
    ["https://a.com/pricing", "Pricing", "product"],
    ["https://a.com/", "Home", "product"],
    ["https://a.com/blog/why", "Why we read", "blog"],
  ])("%s -> %s", (url, title, expected) => {
    expect(classifySerpPageType(url, title)).toBe(expected);
  });
});

describe("clusterKeywordsBySerp", () => {
  const shared3 = ["https://a.com/p", "https://b.com/p", "https://c.com/p"];

  it("joins keywords sharing 3+ top-10 URLs, highest volume as head", () => {
    const clusters = clusterKeywordsBySerp(
      [
        serp("small", 10, [...shared3, ...pages("x", 3)]),
        serp("big", 500, [...shared3, ...pages("y", 3)]),
      ],
      null,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ head: "big", totalVolume: 510 });
    expect(clusters[0].sharedUrls.map((u) => u.url)).toEqual([
      "a.com/p",
      "b.com/p",
      "c.com/p",
    ]);
  });

  it("splits on 2 shared URLs when page types differ, joins when they match", () => {
    const shared2 = ["https://a.com/p", "https://b.com/p"];
    const head = serp("head", 100, [...shared2, ...pages("h", 4)]);
    const sameType = serp("same", 50, [...shared2, ...pages("s", 4)]);
    const otherType: ClusterInput = {
      keyword: "other",
      volume: 40,
      results: [
        ...shared2.map((url, i) => ({
          url,
          title: "A post",
          domain: "d",
          position: i + 1,
        })),
        ...["l1.com", "l2.com", "l3.com", "l4.com"].map((host, i) => ({
          ...listicle(host),
          position: i + 3,
        })),
      ],
    };
    const clusters = clusterKeywordsBySerp([head, sameType, otherType], null);
    expect(clusters.map((c) => c.head)).toEqual(["head", "other"]);
    expect(clusters[0].keywords.map((k) => k.keyword)).toEqual([
      "head",
      "same",
    ]);
  });

  it("compares with the head only, so chains do not merge", () => {
    // a-b share 3, b-c share 3, a-c share 0: c must not ride in through b.
    const a = serp("a", 300, [
      "https://1.com/",
      "https://2.com/",
      "https://3.com/",
      ...pages("a", 3),
    ]);
    const b = serp("b", 200, [
      "https://1.com/",
      "https://2.com/",
      "https://3.com/",
      "https://4.com/",
      "https://5.com/",
      "https://6.com/",
    ]);
    const c = serp("c", 100, [
      "https://4.com/",
      "https://5.com/",
      "https://6.com/",
      ...pages("c", 3),
    ]);
    const clusters = clusterKeywordsBySerp([a, b, c], null);
    expect(clusters.map((cl) => cl.keywords.map((k) => k.keyword))).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });

  it("flags cannibalization and split on own pages", () => {
    const clusters = clusterKeywordsBySerp(
      [
        serp("k1", 300, [own("one"), ...shared3, ...pages("p", 3)]),
        serp("k2", 200, [own("two"), ...shared3, ...pages("q", 3)]),
        serp("k3", 100, [own("one"), ...pages("r", 5)]),
      ],
      "mine.com",
    );
    const [first, second] = clusters;
    expect(first.cannibalization).toBe(true);
    expect(first.split).toBe(true);
    expect(first.splitPages).toEqual(["mine.com/one"]);
    expect(second.cannibalization).toBe(false);
    expect(second.split).toBe(true);
  });
});
