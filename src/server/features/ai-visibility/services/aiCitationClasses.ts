import { countBy } from "remeda";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";
import type { AiCitationClassesInput } from "@/types/schemas/ai-visibility";
import { loadAiCitationEvidence } from "./aiVisibilityResults";
import { classifyCitationSources } from "./citationSources";

/**
 * The pages AI answers cite, classified by type with a suggested action. Reads
 * stored answers and the project's context only; it never collects or crawls.
 */
export async function classifyAiCitations(input: AiCitationClassesInput) {
  const { limit, type, ...scope } = input;
  const [evidence, context] = await Promise.all([
    loadAiCitationEvidence(scope),
    ProjectContextService.getProjectContext(input.projectId),
  ]);
  const ownDomain =
    evidence.observations
      .flatMap((observation) => observation.brands)
      .find((brand) => brand.own)?.domain ?? null;
  const classified = classifyCitationSources(
    evidence.sources,
    evidence.observations.map((observation) => ({
      id: observation.id,
      prompt: observation.prompt,
      engine: observation.engine,
      brandMentioned: observation.brands.some((b) => b.own && b.mentioned),
    })),
    {
      ownDomain,
      competitors: context.competitors,
      customSections: context.customSections,
    },
  );
  const filtered = type
    ? classified.filter((row) => row.type === type)
    : classified;
  return {
    runId: evidence.runId,
    coverage: evidence.coverage,
    appliedFilters: evidence.appliedFilters,
    ownDomain,
    totalPages: classified.length,
    byType: countBy(classified, (row) => row.type),
    rows: filtered.slice(0, limit),
    truncated: filtered.length > limit,
  };
}
