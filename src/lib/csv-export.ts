import "server-only";

import { buildCsv, buildCsvFilename } from "@/lib/csv";
import {
  buildWalletProofInfo,
  buildHorizonDebugInfo,
} from "@/lib/registration-insights";
import type { ContributorRow } from "@/types";

const CSV_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cachedCsv: { data: string; timestamp: number } | null = null;

/**
 * CRITICAL: CSV column order is contractual.
 * Finance reconciliation scripts depend on this exact order.
 * Any change to column order or count breaks Wave payout processing.
 *
 * Golden tests in csv-export.test.ts enforce this stability.
 */
export const CSV_COLUMN_ORDER = [
  "id",
  "githubUsername",
  "stellarAddress",
  "funded",
  "trustlineReady",
  "trustlineAuthorized",
  "verified",
  "xlmBalance",
  "spendableXlmBalance",
  "readiness",
  "lastCheckedAt",
  "horizonDebugSummary",
  "horizonNextAction",
  "freighterProofChallenge",
] as const;

/**
 * Validate that CSV output matches declared column order.
 * Throws if column order is violated.
 *
 * This is called in tests to catch accidental column reordering.
 */
export function validateCsvColumnOrder(csv: string): void {
  const lines = csv.split("\n");
  if (lines.length === 0) return;

  const headerLine = lines[0];
  const actualColumns = headerLine
    .split(",")
    .map((col) => col.replace(/"/g, ""));

  const expectedColumns = [...CSV_COLUMN_ORDER];

  if (actualColumns.length !== expectedColumns.length) {
    throw new Error(
      `Column count mismatch: expected ${expectedColumns.length}, got ${actualColumns.length}`
    );
  }

  for (let i = 0; i < expectedColumns.length; i++) {
    if (actualColumns[i] !== expectedColumns[i]) {
      throw new Error(
        `Column order mismatch at position ${i}: expected "${expectedColumns[i]}", got "${actualColumns[i]}"`
      );
    }
  }
}

export function buildContributorsCsv(contributors: ContributorRow[]): string {
  const headers = [...CSV_COLUMN_ORDER];

  const rows = contributors.map((contributor) => {
    const horizonDebug =
      contributor.horizonDebug ??
      buildHorizonDebugInfo({
        funded: contributor.funded,
        trustlineReady: contributor.trustlineReady,
        trustlineAuthorized: contributor.trustlineAuthorized,
        readiness: contributor.readiness,
        xlmBalance: contributor.xlmBalance,
        spendableXlmBalance: contributor.spendableXlmBalance,
        lastCheckedAt: contributor.lastCheckedAt,
      });
    const walletProof =
      contributor.walletProof ??
      buildWalletProofInfo(
        contributor.stellarAddress,
        contributor.githubUsername
      );

    return [
      contributor.id,
      contributor.githubUsername,
      contributor.stellarAddress,
      contributor.funded ? "yes" : "no",
      contributor.trustlineReady ? "yes" : "no",
      contributor.trustlineAuthorized ? "yes" : "no",
      contributor.verified ? "yes" : "no",
      contributor.xlmBalance,
      contributor.spendableXlmBalance,
      contributor.readiness,
      contributor.lastCheckedAt || "",
      horizonDebug.summary,
      horizonDebug.nextAction,
      walletProof.challenge,
    ];
  });

  return buildCsv(headers, rows);
}

export function getContributorsCsvFilename(date = new Date()): string {
  return buildCsvFilename("contributors", date);
}

export function getCachedCsv(contributors: ContributorRow[]): string {
  const now = Date.now();

  if (
    cachedCsv &&
    now - cachedCsv.timestamp < CSV_CACHE_TTL
  ) {
    return cachedCsv.data;
  }

  const csv = buildContributorsCsv(contributors);
  cachedCsv = { data: csv, timestamp: now };
  return csv;
}

export function invalidateCsvCache(): void {
  cachedCsv = null;
}
