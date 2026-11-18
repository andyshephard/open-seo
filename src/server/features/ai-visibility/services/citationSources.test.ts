import { describe, expect, it } from "vitest";
import {
  classifyCitation,
  classifyCitationSources,
  type CitationClassifierContext,
} from "./citationSources";

const context: CitationClassifierContext = {
  ownDomain: "chunks.app",
  competitors: [
    { domain: "nerdsip.com", name: "NerdSip", notes: null },
    { domain: "nibble.app", name: null, notes: null },
  ],
  customSections: [
    {
      slug: "nerdsip-rule",
      title: "NerdSip rule",
      content: "Never write NerdSip alternatives content. We like cake.",
    },
  ],
};

const classify = (url: string, title: string | null = null) =>
  classifyCitation({ url, domain: new URL(url).hostname, title }, context);

describe("classifyCitation", () => {
  it.each([
    [
      "https://www.chunks.app/stories/x",
      null,
      "own",
      "keep facts current on this page",
    ],
    [
      "https://reddit.com/r/a/comments/1",
      "Thread",
      "reddit",
      "reply in thread (disclosed)",
    ],
    ["https://www.youtube.com/watch?v=1", null, "youtube", "pitch creator"],
    [
      "https://quora.com/q",
      null,
      "forum",
      "review thread; reply only where it fits (disclosed)",
    ],
    [
      "https://en.wikipedia.org/wiki/X",
      null,
      "reference",
      "review; reference sources are hard to influence",
    ],
    ["https://apps.apple.com/app/id1", null, "app_store", "ASO, not web"],
    [
      "https://blog.example.com/p",
      "10 best learning apps",
      "listicle",
      "pitch to be added",
    ],
    ["https://example.com/top-5-apps", null, "listicle", "pitch to be added"],
    ["https://www.theverge.com/a", "A launch", "news", "pitch the publication"],
    ["https://example.com/about", "About", "other", "review"],
  ])("%s -> %s", (url, title, type, action) => {
    expect(classify(url, title)).toMatchObject({ type, action });
  });

  it("recommends a comparison page for a competitor", () => {
    expect(classify("https://nibble.app/")).toMatchObject({
      type: "competitor",
      action: "comparison/alternatives page",
    });
  });

  it("marks a competitor monitor-only when a context rule says never", () => {
    const result = classify("https://nerdsip.com/blog");
    expect(result).toMatchObject({
      type: "competitor",
      action: "monitor only",
    });
    expect(result.note).toContain("Never write NerdSip alternatives content");
  });

  it("does not let a competitor-named listicle on another site count as the competitor", () => {
    expect(classify("https://example.com/nerdsip-alternatives")).toMatchObject({
      type: "listicle",
    });
  });
});

describe("classifyCitationSources", () => {
  it("counts answers across prompts and engines, and brand mentions", () => {
    const rows = classifyCitationSources(
      [
        {
          observationId: "o1",
          url: "https://a.com/best?x=1",
          domain: "a.com",
          title: null,
        },
        {
          observationId: "o2",
          url: "https://www.a.com/best/",
          domain: "a.com",
          title: "Best apps",
        },
        {
          observationId: "o3",
          url: "https://reddit.com/r/x",
          domain: "reddit.com",
          title: null,
        },
        {
          observationId: "o9",
          url: "https://ignored.com/",
          domain: "ignored.com",
          title: null,
        },
      ],
      [
        { id: "o1", prompt: "p1", engine: "chatgpt", brandMentioned: true },
        { id: "o2", prompt: "p2", engine: "gemini", brandMentioned: false },
        { id: "o3", prompt: "p1", engine: "chatgpt", brandMentioned: false },
      ],
      context,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      citationCount: 2,
      type: "listicle",
      title: "Best apps",
      prompts: ["p1", "p2"],
      brandMentionedInAnswers: 1,
      brandMentioned: true,
    });
    expect(rows[0].engines).toEqual([
      { engine: "chatgpt", citations: 1 },
      { engine: "gemini", citations: 1 },
    ]);
    expect(rows[1]).toMatchObject({ type: "reddit", citationCount: 1 });
  });
});
