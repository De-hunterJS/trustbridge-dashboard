import { describe, expect, it, beforeEach } from "vitest";

import {
  buildActionLookupResult,
  computeNextAction,
  cacheAction,
  getCachedAction,
  invalidateActionCache,
  invalidateActionCacheByPin,
  clearActionCache,
  DEFAULT_ACTION_CACHE_CONFIG,
} from "@/lib/action-lookup";
import type { HorizonCheckResult } from "@/types";

function result(overrides: Partial<HorizonCheckResult>): HorizonCheckResult {
  return {
    funded: false,
    trustline: false,
    trustline_authorized: false,
    verified: false,
    xlm_balance: "0",
    spendable_xlm_balance: "0",
    errors: [],
    readiness: "not_ready",
    ...overrides,
  };
}

describe("computeNextAction", () => {
  it("tells an unfunded account to fund itself (success path)", () => {
    expect(
      computeNextAction({
        funded: false,
        trustline: false,
        trustline_authorized: false,
        readiness: "not_ready",
      })
    ).toBe("fund_account");
  });

  it("tells a funded account without a trustline to add one", () => {
    expect(
      computeNextAction({
        funded: true,
        trustline: false,
        trustline_authorized: false,
        readiness: "not_ready",
      })
    ).toBe("add_trustline");
  });

  it("tells a funded account with an unauthorized trustline to wait on the issuer", () => {
    expect(
      computeNextAction({
        funded: true,
        trustline: true,
        trustline_authorized: false,
        readiness: "not_ready",
      })
    ).toBe("await_trustline_authorization");
  });

  it("tells a low-reserve account to top up XLM", () => {
    expect(
      computeNextAction({
        funded: true,
        trustline: true,
        trustline_authorized: true,
        readiness: "low_reserve",
      })
    ).toBe("increase_reserve");
  });

  it("reports no action needed once ready", () => {
    expect(
      computeNextAction({
        funded: true,
        trustline: true,
        trustline_authorized: true,
        readiness: "ready",
      })
    ).toBe("none");
  });
});

describe("buildActionLookupResult", () => {
  it("preserves the underlying Horizon errors on a failure path", () => {
    const horizonResult = result({
      errors: ["Horizon error: rate limited"],
    });

    const lookup = buildActionLookupResult(horizonResult);

    expect(lookup.errors).toEqual(["Horizon error: rate limited"]);
    expect(lookup.nextAction).toBe("fund_account");
  });

  it("merges the computed next action alongside the readiness fields", () => {
    const horizonResult = result({
      funded: true,
      trustline: true,
      trustline_authorized: true,
      xlm_balance: "5",
      readiness: "ready",
    });

    expect(buildActionLookupResult(horizonResult)).toEqual({
      ...horizonResult,
      nextAction: "none",
    });
  });
});

describe("action-lookup caching with TTL", () => {
  const testAddress = "GABC123456789";
  const testResult = buildActionLookupResult(
    result({
      funded: true,
      trustline: true,
      trustline_authorized: true,
      readiness: "ready",
    })
  );

  beforeEach(() => {
    clearActionCache();
  });

  describe("getCachedAction and cacheAction", () => {
    it("returns null on cache miss", () => {
      expect(getCachedAction(testAddress)).toBeNull();
    });

    it("caches and retrieves action lookup results", () => {
      cacheAction(testAddress, testResult);
      const cached = getCachedAction(testAddress);

      expect(cached).toEqual(testResult);
    });

    it("respects TTL and expires cached entries", () => {
      const shortTtlConfig = { ttlMs: 50, maxSize: 100 };
      cacheAction(testAddress, testResult, undefined, shortTtlConfig);

      // Should exist immediately
      expect(getCachedAction(testAddress, undefined, shortTtlConfig)).toEqual(
        testResult
      );

      // Wait for expiry
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(
            getCachedAction(testAddress, undefined, shortTtlConfig)
          ).toBeNull();
          resolve();
        }, 100);
      });
    });

    it("caches results with version pins", () => {
      const pin = "v1.0.0";
      cacheAction(testAddress, testResult, pin);

      expect(getCachedAction(testAddress, pin)).toEqual(testResult);
    });

    it("invalidates cache on pin mismatch", () => {
      cacheAction(testAddress, testResult, "v1.0.0");

      // Different pin should invalidate
      expect(getCachedAction(testAddress, "v2.0.0")).toBeNull();

      // Original entry should be deleted after pin mismatch
      expect(getCachedAction(testAddress, "v1.0.0")).toBeNull();
    });

    it("enforces max cache size with LRU eviction", () => {
      const smallConfig = { ttlMs: 60000, maxSize: 2 };

      cacheAction("addr1", testResult, undefined, smallConfig);
      cacheAction("addr2", testResult, undefined, smallConfig);
      cacheAction("addr3", testResult, undefined, smallConfig);

      // First entry should be evicted
      expect(getCachedAction("addr1", undefined, smallConfig)).toBeNull();
      expect(getCachedAction("addr2", undefined, smallConfig)).toEqual(
        testResult
      );
      expect(getCachedAction("addr3", undefined, smallConfig)).toEqual(
        testResult
      );
    });
  });

  describe("invalidateActionCache", () => {
    it("removes specific address from cache", () => {
      cacheAction(testAddress, testResult);
      cacheAction("OTHER_ADDRESS", testResult);

      invalidateActionCache(testAddress);

      expect(getCachedAction(testAddress)).toBeNull();
      expect(getCachedAction("OTHER_ADDRESS")).toEqual(testResult);
    });
  });

  describe("invalidateActionCacheByPin", () => {
    it("invalidates all entries with matching pin", () => {
      cacheAction("addr1", testResult, "v1.0.0");
      cacheAction("addr2", testResult, "v1.0.0");
      cacheAction("addr3", testResult, "v2.0.0");

      invalidateActionCacheByPin("v1.0.0");

      expect(getCachedAction("addr1", "v1.0.0")).toBeNull();
      expect(getCachedAction("addr2", "v1.0.0")).toBeNull();
      expect(getCachedAction("addr3", "v2.0.0")).toEqual(testResult);
    });

    it("clears entire cache when no pin specified", () => {
      cacheAction("addr1", testResult, "v1.0.0");
      cacheAction("addr2", testResult, "v2.0.0");

      invalidateActionCacheByPin();

      expect(getCachedAction("addr1", "v1.0.0")).toBeNull();
      expect(getCachedAction("addr2", "v2.0.0")).toBeNull();
    });
  });

  describe("clearActionCache", () => {
    it("removes all cached entries", () => {
      cacheAction("addr1", testResult);
      cacheAction("addr2", testResult);

      clearActionCache();

      expect(getCachedAction("addr1")).toBeNull();
      expect(getCachedAction("addr2")).toBeNull();
    });
  });

  describe("cache behavior under pin changes (failure path)", () => {
    it("rejects cached result when action version pin changes mid-Wave", () => {
      const initialPin = "sha-abc123";
      const updatedPin = "sha-def456";

      cacheAction(testAddress, testResult, initialPin);

      // First lookup succeeds with matching pin
      expect(getCachedAction(testAddress, initialPin)).toEqual(testResult);

      // Pin change causes cache miss and invalidation
      expect(getCachedAction(testAddress, updatedPin)).toBeNull();

      // Subsequent lookups should also miss
      expect(getCachedAction(testAddress, initialPin)).toBeNull();
    });
  });
});
