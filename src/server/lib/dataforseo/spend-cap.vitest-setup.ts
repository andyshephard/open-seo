import { vi } from "vitest";

// core.ts holds every DataForSEO request against the monthly spend cap
// (spend-cap.ts), which needs the database. The many tests that drive the
// DataForSEO fetchers have none, so by default the hold lets everything
// through and records nothing. spend-cap.test.ts unmocks the module and tests
// the real cap against an in-memory SQLite database.
vi.mock("@/server/lib/dataforseo/spend-cap", () => ({
  holdDataforseoSpend: async () => ({
    settle: async () => {},
    settleAtEstimate: async () => {},
    fail: async () => {},
  }),
}));
