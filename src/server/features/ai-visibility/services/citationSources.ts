import { sort } from "remeda";
import { ownedAiDomain } from "./aiVisibilityMatching";

// Classifies the pages AI answers cite, so an agent can see which kinds of
// pages feed the answers and what to do about each. Pure: the caller reads the
// stored citations and the project's context and hands them in.

type CitationType =
  | "own"
  | "competitor"
  | "listicle"
  | "reddit"
  | "youtube"
  | "forum"
  | "reference"
  | "news"
  | "app_store"
  | "other";

export type CitationCompetitor = {
  domain: string;
  name: string | null;
  notes: string | null;
};

export type CitationClassifierContext = {
  /** The project's own domain, from the tracked brand. */
  ownDomain: string | null;
  competitors: CitationCompetitor[];
  /** The project's custom context sections, for per-competitor rules. */
  customSections: { slug: string; title: string | null; content: string }[];
};

type CitationClassification = {
  type: CitationType;
  action: string;
  /** Why a competitor is monitor-only, when it is. */
  note: string | null;
};

type CitedObservation = {
  id: string;
  prompt: string;
  engine: string;
  /** Whether the project's brand is named in this answer. */
  brandMentioned: boolean;
};

type CitedSource = {
  observationId: string;
  url: string;
  domain: string;
  title: string | null;
};

const ACTIONS: Record<Exclude<CitationType, "competitor">, string> = {
  own: "keep facts current on this page",
  listicle: "pitch to be added",
  reddit: "reply in thread (disclosed)",
  youtube: "pitch creator",
  forum: "review thread; reply only where it fits (disclosed)",
  reference: "review; reference sources are hard to influence",
  news: "pitch the publication",
  app_store: "ASO, not web",
  other: "review",
};

const FORUM_DOMAINS = [
  "quora.com",
  "stackoverflow.com",
  "stackexchange.com",
  "news.ycombinator.com",
  "discourse.org",
];
const REFERENCE_DOMAINS = [
  "wikipedia.org",
  "wikimedia.org",
  "wikihow.com",
  "britannica.com",
  "merriam-webster.com",
  "dictionary.com",
  "investopedia.com",
];
const NEWS_DOMAINS = [
  "nytimes.com",
  "washingtonpost.com",
  "theguardian.com",
  "bbc.com",
  "bbc.co.uk",
  "cnn.com",
  "reuters.com",
  "forbes.com",
  "businessinsider.com",
  "techcrunch.com",
  "theverge.com",
  "wired.com",
  "bloomberg.com",
  "medium.com",
  "substack.com",
  "mashable.com",
  "cnet.com",
  "zdnet.com",
  "fastcompany.com",
  "inc.com",
  "theatlantic.com",
];
const APP_STORE_DOMAINS = ["apps.apple.com", "play.google.com"];
const LISTICLE_PATTERN =
  /\b(best|alternatives?|vs\.?)\b|\btop[\s-]?\d+\b|\b\d+\s+best\b/i;

function domainIn(host: string, domains: string[]) {
  return domains.some((domain) => ownedAiDomain(host, domain));
}

function cleanHost(domain: string) {
  return domain.toLowerCase().replace(/^www\./, "");
}

/** The words a context note may use for a competitor: domain, name, label. */
function competitorNames(competitor: CitationCompetitor): string[] {
  const label = cleanHost(competitor.domain).split(".")[0];
  return [cleanHost(competitor.domain), competitor.name, label]
    .filter((name): name is string => !!name && name.length >= 3)
    .map((name) => name.toLowerCase());
}

/**
 * A competitor is monitor-only when its own notes, or a sentence of a custom
 * context section that names it, say "monitor only" or "never" (for example a
 * rule "never write NerdSip alternatives content").
 */
function competitorMonitorNote(
  competitor: CitationCompetitor,
  customSections: CitationClassifierContext["customSections"],
): string | null {
  const rule = /\bmonitor[\s-]+only\b|\bnever\b/i;
  if (competitor.notes && rule.test(competitor.notes))
    return `Competitor notes: ${competitor.notes}`;
  const names = competitorNames(competitor);
  for (const section of customSections) {
    for (const sentence of section.content.split(/[\n.!?]+/)) {
      const lower = sentence.toLowerCase();
      if (rule.test(sentence) && names.some((name) => lower.includes(name)))
        return `Context section "${section.title ?? section.slug}": ${sentence.trim()}`;
    }
  }
  return null;
}

function hostOf(url: string, fallback: string) {
  try {
    return cleanHost(new URL(url).hostname);
  } catch {
    return cleanHost(fallback);
  }
}

export function classifyCitation(
  source: Pick<CitedSource, "url" | "domain" | "title">,
  context: CitationClassifierContext,
): CitationClassification {
  const host = hostOf(source.url, source.domain);
  if (context.ownDomain && ownedAiDomain(host, context.ownDomain))
    return { type: "own", action: ACTIONS.own, note: null };
  const competitor = context.competitors.find((c) =>
    ownedAiDomain(host, c.domain),
  );
  if (competitor) {
    const note = competitorMonitorNote(competitor, context.customSections);
    return {
      type: "competitor",
      action: note ? "monitor only" : "comparison/alternatives page",
      note,
    };
  }
  const pick = (type: Exclude<CitationType, "competitor">) => ({
    type,
    action: ACTIONS[type],
    note: null,
  });
  if (domainIn(host, APP_STORE_DOMAINS)) return pick("app_store");
  if (ownedAiDomain(host, "reddit.com")) return pick("reddit");
  if (ownedAiDomain(host, "youtube.com") || host === "youtu.be")
    return pick("youtube");
  if (domainIn(host, FORUM_DOMAINS)) return pick("forum");
  if (domainIn(host, REFERENCE_DOMAINS)) return pick("reference");
  let path = "";
  try {
    path = new URL(source.url).pathname;
  } catch {
    path = "";
  }
  if (LISTICLE_PATTERN.test(`${source.title ?? ""} ${path}`))
    return pick("listicle");
  if (domainIn(host, NEWS_DOMAINS) || host.startsWith("news."))
    return pick("news");
  return pick("other");
}

function pageKey(url: string) {
  try {
    const parsed = new URL(url);
    return `${cleanHost(parsed.hostname)}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/**
 * One row per cited page: how many answers cite it (across prompts and
 * engines), which prompts and engines, and whether the brand is named in those
 * answers. Sorted by citation count.
 */
export function classifyCitationSources(
  sources: CitedSource[],
  observations: CitedObservation[],
  context: CitationClassifierContext,
) {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const groups = new Map<
    string,
    {
      url: string;
      domain: string;
      title: string | null;
      answers: Set<string>;
    }
  >();
  for (const source of sources) {
    if (!byId.has(source.observationId)) continue;
    const key = pageKey(source.url);
    const group = groups.get(key) ?? {
      url: source.url,
      domain: source.domain,
      title: source.title,
      answers: new Set<string>(),
    };
    group.title ??= source.title;
    group.answers.add(source.observationId);
    groups.set(key, group);
  }
  const rows = [...groups.values()].map((group) => {
    const answers = [...group.answers].flatMap((id) => byId.get(id) ?? []);
    const engines = new Map<string, number>();
    for (const answer of answers)
      engines.set(answer.engine, (engines.get(answer.engine) ?? 0) + 1);
    return {
      url: group.url,
      domain: group.domain,
      title: group.title,
      ...classifyCitation(group, context),
      citationCount: answers.length,
      prompts: [...new Set(answers.map((a) => a.prompt))],
      engines: [...engines].map(([engine, citations]) => ({
        engine,
        citations,
      })),
      brandMentionedInAnswers: answers.filter((a) => a.brandMentioned).length,
      brandMentioned: answers.some((a) => a.brandMentioned),
    };
  });
  return sort(
    rows,
    (a, b) => b.citationCount - a.citationCount || a.url.localeCompare(b.url),
  );
}
