// Module mocks that take research storage (archive, lookup cache, stored
// keyword metrics) out of MCP tool tests, so each paid call goes straight to
// the mocked provider client. Use as vi.mock factories:
//   vi.mock(path, () => import("./research-storage-test-mocks").then((m) => m.archiveModule))

export const archiveModule = {
  archiveLookup: async () => false,
  archiveParams: () => ({}),
  readArchivedView: async () => null,
};

export const cachedLookupModule = {
  cachedLookup: async (
    _customer: unknown,
    _lookup: unknown,
    fetch: () => Promise<unknown>,
  ) => ({ value: await fetch(), fetchedAt: "", cached: false }),
  readCachedLookup: async () => null,
  storeLookupResult: async () => undefined,
  rememberLookupTask: async () => undefined,
  recallLookupTask: async () => null,
};

export const keywordRepositoryModule = {
  KeywordResearchRepository: {
    listStoredKeywordMetrics: async () => [],
    upsertKeywordMetric: async () => undefined,
  },
};

export const historyCaptureModule = {
  captureKeywordMetrics: async () => undefined,
};
