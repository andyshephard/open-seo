import { beforeEach, describe, expect, it, vi } from "vitest";
import { GscApiError, GscTokenError } from "@/server/lib/gscErrors";
import { GscService } from "./GscService";

const mocks = vi.hoisted(() => {
  const state: { selectRows: Array<{ id: string; accountId: string }> } = {
    selectRows: [],
  };
  type GscClientOptions = { userId: string; gscAccountId?: string };
  type GscSite = { siteUrl: string; permissionLevel: string };
  const listSites = vi.fn<(opts: GscClientOptions) => Promise<GscSite[]>>();
  const getUserInfoEmail =
    vi.fn<(opts: GscClientOptions) => Promise<string | null>>();
  const querySearchAnalytics =
    vi.fn<(opts: GscClientOptions) => Promise<never[]>>();
  const dbSelect = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        const rows = state.selectRows;
        return Object.assign(Promise.resolve(rows), {
          limit: vi.fn().mockResolvedValue(rows),
        });
      }),
    })),
  }));

  return {
    state,
    dbSelect,
    listSites,
    getUserInfoEmail,
    querySearchAnalytics,
    createGscClient: vi.fn((opts: GscClientOptions) => ({
      listSites: () => listSites(opts),
      getUserInfoEmail: () => getUserInfoEmail(opts),
      querySearchAnalytics: () => querySearchAnalytics(opts),
    })),
    upsert: vi.fn(),
    getByProjectId: vi.fn(),
    deleteByProjectId: vi.fn(),
    deleteGscCache: vi.fn(),
    deleteSearchConsoleCopies: vi.fn(),
  };
});

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: { select: mocks.dbSelect },
}));
vi.mock("@/server/lib/gscClient", () => ({
  createGscClient: mocks.createGscClient,
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: {
    upsert: mocks.upsert,
    getByProjectId: mocks.getByProjectId,
    deleteByProjectId: mocks.deleteByProjectId,
  },
}));
vi.mock("@/server/features/dashboard/services/DashboardCacheService", () => ({
  DashboardCacheService: { deleteGscCache: mocks.deleteGscCache },
}));
vi.mock(
  "@/server/features/research-history/services/googleDataErasure",
  () => ({ deleteSearchConsoleCopies: mocks.deleteSearchConsoleCopies }),
);

const baseInput = {
  projectId: "p1",
  organizationId: "org1",
  accountId: "sub-a",
  userId: "u1",
};

function gscConnected(siteUrl: string, gscAccountId: string | null) {
  return {
    projectId: "p1",
    siteUrl,
    gscAccountId,
    connectedByUserId: "u1",
  };
}

describe("GscService.setSite", () => {
  beforeEach(() => {
    mocks.state.selectRows = [{ id: "grant-a", accountId: "sub-a" }];
    mocks.getByProjectId.mockResolvedValue(null);
    mocks.deleteSearchConsoleCopies.mockClear();
    mocks.deleteGscCache.mockClear();
    mocks.listSites.mockResolvedValue([
      { siteUrl: "https://x/", permissionLevel: "siteOwner" },
      { siteUrl: "https://y/", permissionLevel: "siteOwner" },
    ]);
    mocks.upsert.mockResolvedValue({ siteUrl: "https://x/" });
  });

  it.each([
    ["the same property", "https://x/", "sub-a"],
    ["a legacy mapping of the same property", "https://x/", null],
  ])("keeps the stored history when re-picking %s", async (_l, site, acct) => {
    mocks.getByProjectId.mockResolvedValue(gscConnected(site, acct));

    await GscService.setSite({ ...baseInput, siteUrl: "https://x/" });

    expect(mocks.deleteSearchConsoleCopies).not.toHaveBeenCalled();
    expect(mocks.deleteGscCache).not.toHaveBeenCalled();
  });

  it.each([
    ["another property", "https://y/", "sub-a"],
    ["another Google account", "https://x/", "sub-b"],
  ])(
    "deletes the stored history before switching to %s",
    async (_l, site, acct) => {
      mocks.getByProjectId.mockResolvedValue(gscConnected(site, acct));

      await GscService.setSite({ ...baseInput, siteUrl: "https://x/" });

      expect(mocks.deleteSearchConsoleCopies).toHaveBeenCalledWith("p1");
      expect(mocks.deleteGscCache).toHaveBeenCalledWith("p1");
      expect(
        mocks.deleteSearchConsoleCopies.mock.invocationCallOrder[0],
      ).toBeLessThan(mocks.upsert.mock.invocationCallOrder.at(-1) ?? 0);
    },
  );

  it("upserts a verified property with the selected grant and userinfo email", async () => {
    mocks.listSites.mockResolvedValue([
      { siteUrl: "https://x/", permissionLevel: "siteOwner" },
    ]);
    mocks.getUserInfoEmail.mockResolvedValue("client@example.com");
    mocks.upsert.mockResolvedValue({ siteUrl: "https://x/" });

    await GscService.setSite({ ...baseInput, siteUrl: "https://x/" });

    expect(mocks.createGscClient).toHaveBeenCalledWith({
      userId: "u1",
      gscAccountId: "sub-a",
    });
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        siteUrl: "https://x/",
        connectedByUserId: "u1",
        gscAccountId: "sub-a",
        connectedAccountEmail: "client@example.com",
      }),
    );

    // A userinfo failure is non-fatal: the email is passed through as null.
    mocks.getUserInfoEmail.mockRejectedValue(new Error("userinfo unavailable"));
    await GscService.setSite({ ...baseInput, siteUrl: "https://x/" });
    expect(mocks.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectedAccountEmail: null }),
    );
  });

  it("rejects a Google sub that is not one of the caller's grants", async () => {
    await expect(
      GscService.setSite({
        ...baseInput,
        accountId: "foreign-sub",
        siteUrl: "https://x/",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.createGscClient).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unverified property with FORBIDDEN", async () => {
    mocks.listSites.mockResolvedValue([
      { siteUrl: "https://x/", permissionLevel: "siteUnverifiedUser" },
    ]);

    await expect(
      GscService.setSite({ ...baseInput, siteUrl: "https://x/" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a property not on the selected grant with NOT_FOUND", async () => {
    mocks.listSites.mockResolvedValue([
      { siteUrl: "https://x/", permissionLevel: "siteOwner" },
    ]);

    await expect(
      GscService.setSite({ ...baseInput, siteUrl: "https://not-mine/" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe("GscService.listSitesForUserWithGrantStatus", () => {
  beforeEach(() => {
    mocks.state.selectRows = [
      { id: "grant-a", accountId: "sub-a" },
      { id: "grant-b", accountId: "sub-b" },
    ];
  });

  it.each([
    ["a revoked token", new GscTokenError("revoked")],
    ["a 403", new GscApiError(403, "Search Console denied access")],
  ])(
    "marks only the grant that failed with %s for reconnect",
    async (_label, failure) => {
      mocks.getUserInfoEmail.mockImplementation(
        async ({ gscAccountId }: { gscAccountId?: string }) =>
          `${gscAccountId}@example.com`,
      );
      mocks.listSites.mockImplementation(
        async ({ gscAccountId }: { gscAccountId?: string }) => {
          if (gscAccountId === "sub-b") throw failure;
          return [{ siteUrl: "https://x/", permissionLevel: "siteOwner" }];
        },
      );

      await expect(
        GscService.listSitesForUserWithGrantStatus("u1"),
      ).resolves.toEqual({
        accounts: [
          {
            accountId: "sub-a",
            email: "sub-a@example.com",
            requiresReconnect: false,
            propertiesUnavailable: false,
            apiDisabled: false,
            sites: [{ siteUrl: "https://x/", permissionLevel: "siteOwner" }],
          },
          {
            accountId: "sub-b",
            email: null,
            requiresReconnect: true,
            propertiesUnavailable: false,
            apiDisabled: false,
            sites: [],
          },
        ],
      });
      expect(mocks.createGscClient).toHaveBeenCalledTimes(2);
      expect(mocks.getUserInfoEmail).not.toHaveBeenCalledWith(
        expect.objectContaining({ gscAccountId: "sub-b" }),
      );
    },
  );

  it("keeps userinfo failures non-fatal", async () => {
    mocks.state.selectRows = [{ id: "grant-a", accountId: "sub-a" }];
    mocks.getUserInfoEmail.mockRejectedValue(new Error("userinfo unavailable"));
    mocks.listSites.mockResolvedValue([
      { siteUrl: "https://x/", permissionLevel: "siteOwner" },
    ]);

    await expect(
      GscService.listSitesForUserWithGrantStatus("u1"),
    ).resolves.toEqual({
      accounts: [
        {
          accountId: "sub-a",
          email: null,
          requiresReconnect: false,
          propertiesUnavailable: false,
          apiDisabled: false,
          sites: [{ siteUrl: "https://x/", permissionLevel: "siteOwner" }],
        },
      ],
    });
  });

  it.each([
    ["a rate limit", new GscApiError(429, "slow down"), false],
    [
      "a 403 because the API is disabled",
      new GscApiError(403, "denied", "SERVICE_DISABLED"),
      true,
    ],
  ])(
    "keeps %s reportable instead of asking to reconnect",
    async (_label, failure, apiDisabled) => {
      mocks.getUserInfoEmail.mockImplementation(
        async ({ gscAccountId }: { gscAccountId?: string }) =>
          `${gscAccountId}@example.com`,
      );
      mocks.listSites.mockImplementation(
        async ({ gscAccountId }: { gscAccountId?: string }) => {
          if (gscAccountId === "sub-b") throw failure;
          return [{ siteUrl: "https://x/", permissionLevel: "siteOwner" }];
        },
      );
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      await expect(
        GscService.listSitesForUserWithGrantStatus("u1"),
      ).resolves.toEqual({
        accounts: [
          {
            accountId: "sub-a",
            email: "sub-a@example.com",
            requiresReconnect: false,
            propertiesUnavailable: false,
            apiDisabled: false,
            sites: [{ siteUrl: "https://x/", permissionLevel: "siteOwner" }],
          },
          {
            accountId: "sub-b",
            email: null,
            requiresReconnect: false,
            propertiesUnavailable: true,
            apiDisabled,
            sites: [],
          },
        ],
      });
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to list Search Console sites for account",
        "sub-b",
        failure,
      );
      consoleError.mockRestore();
    },
  );
});

describe("GscService.getPerformance", () => {
  beforeEach(() => {
    mocks.querySearchAnalytics.mockResolvedValue([]);
    mocks.getByProjectId.mockResolvedValue({
      connectedByUserId: "u1",
      connectedAccountEmail: null,
      gscAccountId: "sub-a",
      siteUrl: "https://x/",
    });
  });

  it.each([
    ["sub-a", "sub-a"],
    [null, undefined],
  ])(
    "uses the grant stored on the project connection (%s)",
    async (stored, forwarded) => {
      mocks.getByProjectId.mockResolvedValue({
        connectedByUserId: "u1",
        connectedAccountEmail: null,
        gscAccountId: stored,
        siteUrl: "https://x/",
      });

      await GscService.getPerformance({
        projectId: "p1",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(mocks.createGscClient).toHaveBeenCalledWith({
        userId: "u1",
        gscAccountId: forwarded,
      });
    },
  );
  it("uses the API's full query page for internal dashboard requests", async () => {
    const result = await GscService.getPerformance({
      projectId: "p1",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      rowLimit: 25000,
    });
    expect(result.request.rowLimit).toBe(25000);
  });
});

describe("GscService.disconnect", () => {
  it("deletes the stored history and the cache before the connection", async () => {
    mocks.deleteSearchConsoleCopies.mockClear();
    await GscService.disconnect({ projectId: "p1" });

    expect(mocks.deleteByProjectId).toHaveBeenCalledWith("p1");
    expect(mocks.deleteGscCache).toHaveBeenCalledWith("p1");
    // Before, so a failure leaves a retryable disconnect; after, for a sync
    // that wrote in between.
    const [first, second] =
      mocks.deleteSearchConsoleCopies.mock.invocationCallOrder;
    const unmapped = mocks.deleteByProjectId.mock.invocationCallOrder[0];
    expect(first).toBeLessThan(unmapped);
    expect(second).toBeGreaterThan(unmapped);
  });

  it("keeps the connection when deleting the stored history fails", async () => {
    mocks.deleteByProjectId.mockClear();
    mocks.deleteSearchConsoleCopies.mockRejectedValueOnce(new Error("D1"));

    await expect(GscService.disconnect({ projectId: "p1" })).rejects.toThrow();
    expect(mocks.deleteByProjectId).not.toHaveBeenCalled();
  });
});
