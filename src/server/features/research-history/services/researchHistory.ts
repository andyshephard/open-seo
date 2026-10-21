import { groupBy, unique } from "remeda";
import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";
import {
  researchHistoryInputSchema,
  type ResearchHistoryInput,
} from "@/types/schemas/researchHistory";
import { ResearchHistoryRepository as repo } from "../repositories/ResearchHistoryRepository";

type Project = {
  id: string;
  domain: string | null;
  locationCode: number;
  languageCode: string;
};

function sinceDate(months: number) {
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months);
  return since.toISOString().slice(0, 10);
}

/**
 * Stored history for the project's domain, competitors and keywords. Callers
 * pass the project already verified for the caller's organization; every read
 * is scoped to it.
 */
export async function getResearchHistory(
  project: Project,
  rawInput: ResearchHistoryInput,
) {
  const input = researchHistoryInputSchema.parse(rawInput);
  const market = {
    locationCode: input.locationCode ?? project.locationCode,
    languageCode: input.languageCode ?? project.languageCode,
  };
  const since = sinceDate(input.months);

  const competitors = await ProjectContextRepository.listCompetitors(
    project.id,
  );
  const domains = unique(
    input.domains ??
      [project.domain, ...competitors.map((row) => row.domain)].filter(
        (domain): domain is string => !!domain,
      ),
  );
  const keywords = unique(
    (
      input.keywords ??
      (
        await KeywordResearchRepository.listSavedKeywordsByProject({
          projectId: project.id,
        })
      ).rows
        .filter(
          ({ row }) =>
            row.locationCode === market.locationCode &&
            row.languageCode === market.languageCode,
        )
        .map(({ row }) => row.keyword)
    ).map(normalizeKeyword),
  ).slice(0, 100);

  const [overviewRows, backlinkRows, keywordRows, capturedDomains] =
    await Promise.all([
      repo.listDomainSnapshots({
        projectId: project.id,
        domains,
        ...market,
        since,
      }),
      repo.listBacklinkSnapshots({
        projectId: project.id,
        domains,
        includeSubdomains: input.includeSubdomains,
        since,
      }),
      repo.listKeywordSnapshots({
        projectId: project.id,
        keywords,
        ...market,
        since,
      }),
      repo.listCapturedDomains(project.id),
    ]);
  const overviewByDomain = groupBy(overviewRows, (row) => row.domain);
  const backlinksByDomain = groupBy(backlinkRows, (row) => row.domain);
  const keywordsByName = groupBy(keywordRows, (row) => row.keyword);

  return {
    market,
    since,
    includeSubdomains: input.includeSubdomains,
    // Domains with stored history that are not in this view (e.g. a domain
    // looked up once), so a picker can offer them.
    otherCapturedDomains: capturedDomains.filter(
      (domain) => !domains.includes(domain),
    ),
    domains: domains.map((domain) => ({
      domain,
      own: domain === project.domain,
      overview: (overviewByDomain[domain] ?? []).map((row) => ({
        date: row.capturedOn,
        organicTraffic: row.organicTraffic,
        organicKeywords: row.organicKeywords,
        top3Keywords: row.top3Keywords,
        top10Keywords: row.top10Keywords,
      })),
      backlinks: (backlinksByDomain[domain] ?? []).map((row) => ({
        date: row.capturedOn,
        rank: row.rank,
        backlinks: row.backlinks,
        referringDomains: row.referringDomains,
        referringPages: row.referringPages,
        brokenBacklinks: row.brokenBacklinks,
        newBacklinks: row.newBacklinks,
        lostBacklinks: row.lostBacklinks,
        newReferringDomains: row.newReferringDomains,
        lostReferringDomains: row.lostReferringDomains,
        spamScore: row.spamScore,
        domainRating: row.domainRating,
      })),
    })),
    keywords: keywords.map((keyword) => ({
      keyword,
      snapshots: (keywordsByName[keyword] ?? []).map((row) => ({
        date: row.capturedOn,
        searchVolume: row.searchVolume,
        keywordDifficulty: row.keywordDifficulty,
        cpc: row.cpc,
        competition: row.competition,
      })),
    })),
  };
}
