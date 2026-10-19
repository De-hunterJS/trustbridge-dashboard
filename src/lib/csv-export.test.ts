import { describe, it, expect, beforeEach } from "vitest";
import {
  buildContributorsCsv,
  getContributorsCsvFilename,
  getCachedCsv,
  invalidateCsvCache,
  CSV_COLUMN_ORDER,
  validateCsvColumnOrder,
} from "./csv-export";
import type { ContributorRow } from "@/types";

describe("csv-export", () => {
  const mockContributors: ContributorRow[] = [
    {
      id: "1",
      githubUsername: "alice",
      stellarAddress: "GA1234567890ABCDEF",
      funded: true,
      trustlineReady: true,
      trustlineAuthorized: true,
      verified: true,
      xlmBalance: "100.5",
      spendableXlmBalance: "99.5",
      readiness: "ready",
      lastCheckedAt: "2026-07-25T10:00:00Z",
    },
    {
      id: "2",
      githubUsername: "bob",
      stellarAddress: "GB1234567890ABCDEF",
      funded: true,
      trustlineReady: false,
      trustlineAuthorized: false,
      verified: false,
      xlmBalance: "50.0",
      spendableXlmBalance: "48.0",
      readiness: "not_ready",
      lastCheckedAt: "2026-07-24T10:00:00Z",
    },
  ];

  beforeEach(() => {
    invalidateCsvCache();
  });

  it("should build CSV with correct headers and data", () => {
    const csv = buildContributorsCsv(mockContributors);

    expect(csv).toContain('"id","githubUsername","stellarAddress"');
    expect(csv).toContain('"1","alice"');
    expect(csv).toContain('"2","bob"');
    expect(csv).toContain('"ready"');
    expect(csv).toContain('"not_ready"');
    expect(csv).toContain("TrustBridge Freighter ownership proof");
  });

  it("should handle empty contributor list", () => {
    const csv = buildContributorsCsv([]);
    expect(csv).toContain('"id","githubUsername","stellarAddress"');
  });

  it("should escape CSV special characters correctly", () => {
    const contributor: ContributorRow = {
      ...mockContributors[0],
      githubUsername: 'alice"quoted"name',
    };

    const csv = buildContributorsCsv([contributor]);
    expect(csv).toContain('alice""quoted""name');
  });

  it("should generate filename with date", () => {
    const date = new Date("2026-07-25");
    const filename = getContributorsCsvFilename(date);

    expect(filename).toBe("contributors-2026-07-25.csv");
  });

  it("should cache CSV and return same data", () => {
    const csv1 = getCachedCsv(mockContributors);
    const csv2 = getCachedCsv([]);

    expect(csv1).toBe(csv2);
  });

  it("should invalidate cache", () => {
    const csv1 = getCachedCsv(mockContributors);
    invalidateCsvCache();
    const csv2 = getCachedCsv([]);

    expect(csv1).not.toBe(csv2);
  });

  it("should handle null lastCheckedAt", () => {
    const contributor: ContributorRow = {
      ...mockContributors[0],
      lastCheckedAt: null,
    };

    const csv = buildContributorsCsv([contributor]);
    expect(csv).toContain('"ready","","All Horizon readiness checks currently pass for this row."');
  });

  it("should format boolean values as yes/no", () => {
    const csv = buildContributorsCsv(mockContributors);

    expect(csv).toContain('"yes"');
    expect(csv).toContain('"no"');
  });

  it("derives debug and proof fields when they are missing on the row", () => {
    const csv = buildContributorsCsv([
      {
        ...mockContributors[1],
        walletProof: undefined,
        horizonDebug: undefined,
      },
    ]);

    expect(csv).toContain("Required USDC trustline is missing.");
    expect(csv).toContain("TrustBridge Freighter ownership proof");
  });
});

describe("CSV column order stability (golden tests)", () => {
  const mockContributor: ContributorRow = {
    id: "1",
    githubUsername: "alice",
    stellarAddress: "GA1234567890ABCDEF",
    funded: true,
    trustlineReady: true,
    trustlineAuthorized: true,
    verified: true,
    xlmBalance: "100.5",
    spendableXlmBalance: "99.5",
    readiness: "ready",
    lastCheckedAt: "2026-07-25T10:00:00Z",
  };

  it("exports columns in exact order defined by CSV_COLUMN_ORDER", () => {
    const csv = buildContributorsCsv([mockContributor]);
    const lines = csv.split("\n");
    const headerLine = lines[0];

    const expectedHeader = CSV_COLUMN_ORDER.map((col) => `"${col}"`).join(",");

    expect(headerLine).toBe(expectedHeader);
  });

  it("golden test: CSV header must match exact column order", () => {
    const csv = buildContributorsCsv([mockContributor]);
    const lines = csv.split("\n");

    // Golden assertion — this snapshot must NOT change across releases
    // Changing column order breaks finance reconciliation scripts
    expect(lines[0]).toBe(
      '"id","githubUsername","stellarAddress","funded","trustlineReady",' +
        '"trustlineAuthorized","verified","xlmBalance","spendableXlmBalance",' +
        '"readiness","lastCheckedAt","horizonDebugSummary","horizonNextAction",' +
        '"freighterProofChallenge"'
    );
  });

  it("validates actual CSV output matches declared column order", () => {
    const csv = buildContributorsCsv([mockContributor]);

    expect(() => validateCsvColumnOrder(csv)).not.toThrow();
  });

  it("detects column order violations", () => {
    // Simulate a CSV with columns in wrong order
    const wrongOrderCsv =
      '"githubUsername","id","stellarAddress"\n' +
      '"alice","1","GA1234567890ABCDEF"';

    expect(() => validateCsvColumnOrder(wrongOrderCsv)).toThrow(
      /Column order mismatch/
    );
  });

  it("ensures column count stays constant", () => {
    const csv = buildContributorsCsv([mockContributor]);
    const lines = csv.split("\n");
    const headerColumns = lines[0].split(",");

    // Golden assertion — column count must remain 14
    expect(headerColumns).toHaveLength(14);
    expect(CSV_COLUMN_ORDER).toHaveLength(14);
  });

  it("validates data rows match header column count", () => {
    const csv = buildContributorsCsv([mockContributor]);
    const lines = csv.split("\n").filter((line) => line.trim());

    const headerColumnCount = lines[0].split(",").length;

    // Check all data rows have same column count as header
    for (let i = 1; i < lines.length; i++) {
      const rowColumnCount = lines[i].split(",").length;
      expect(rowColumnCount).toBe(headerColumnCount);
    }
  });

  it("protects against accidental column insertion", () => {
    // This test fails if a developer adds a new column without updating
    // the golden test above, preventing silent finance script breakage
    const csv = buildContributorsCsv([mockContributor]);
    const lines = csv.split("\n");
    const actualColumns = lines[0]
      .split(",")
      .map((col) => col.replace(/"/g, ""));

    expect(actualColumns).toEqual(CSV_COLUMN_ORDER);
  });

  it("ensures no column header contains commas or newlines", () => {
    // Commas or newlines in headers would break CSV parsers
    CSV_COLUMN_ORDER.forEach((col) => {
      expect(col).not.toContain(",");
      expect(col).not.toContain("\n");
      expect(col).not.toContain("\r");
    });
  });
});
