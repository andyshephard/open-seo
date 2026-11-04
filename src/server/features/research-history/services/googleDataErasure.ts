import { SearchHistoryRepository } from "../repositories/SearchHistoryRepository";
import { deleteArchivedKinds } from "./researchArchive";

// OpenSEO's own copies of a project's Google data go when the project stops
// sharing it: disconnecting Search Console or GA4, or removing the Google
// account that granted it. Each delete is recorded for the export's
// deletions feed, so a warehouse copy can follow.

/** Search Console: the daily history and archived URL inspections. */
export async function deleteSearchConsoleCopies(projectId: string) {
  await SearchHistoryRepository.deleteProject(projectId);
  await deleteArchivedKinds(projectId, ["url_inspection"]);
}

/** GA4: the archived daily landing-page reports. */
export async function deleteGa4Copies(projectId: string) {
  await deleteArchivedKinds(projectId, ["ga4_landing_pages"]);
}
