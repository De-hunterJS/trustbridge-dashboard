import type { HorizonCheckResult } from "@/types";

/** Pure helpers — safe for client and server; no stellar-sdk. */

export type WizardAction =
  | "fund_account"
  | "add_trustline"
  | "await_trustline_authorization"
  | "increase_reserve"
  | "none";

/**
 * Action version metadata cache configuration.
 * Caches action lookup results to reduce repeated Horizon queries.
 */
export interface ActionCacheConfig {
  /** TTL in milliseconds for cached action metadata */
  ttlMs: number;
  /** Maximum cache size (number of entries) */
  maxSize: number;
}

export const DEFAULT_ACTION_CACHE_CONFIG: ActionCacheConfig = {
  ttlMs: 5 * 60 * 1000, // 5 minutes
  maxSize: 1000,
};

interface CachedActionEntry {
  result: ActionLookupResult;
  timestamp: number;
  pin?: string; // Optional version pin for cache invalidation
}

const actionCache = new Map<string, CachedActionEntry>();

/**
 * Get cached action lookup result if valid (within TTL and pin matches).
 * Returns null if cache miss or expired.
 */
export function getCachedAction(
  address: string,
  pin?: string,
  config: ActionCacheConfig = DEFAULT_ACTION_CACHE_CONFIG
): ActionLookupResult | null {
  const entry = actionCache.get(address);
  if (!entry) return null;

  const now = Date.now();
  const isExpired = now - entry.timestamp > config.ttlMs;
  const isPinMismatch = pin !== undefined && entry.pin !== pin;

  if (isExpired || isPinMismatch) {
    actionCache.delete(address);
    return null;
  }

  return entry.result;
}

/**
 * Cache an action lookup result with optional version pin.
 */
export function cacheAction(
  address: string,
  result: ActionLookupResult,
  pin?: string,
  config: ActionCacheConfig = DEFAULT_ACTION_CACHE_CONFIG
): void {
  // Enforce max cache size using simple LRU (delete oldest)
  if (actionCache.size >= config.maxSize) {
    const firstKey = actionCache.keys().next().value;
    if (firstKey) actionCache.delete(firstKey);
  }

  actionCache.set(address, {
    result,
    timestamp: Date.now(),
    pin,
  });
}

/**
 * Invalidate cached action for a specific address.
 */
export function invalidateActionCache(address: string): void {
  actionCache.delete(address);
}

/**
 * Invalidate all cached actions where pin matches (or all if no pin specified).
 */
export function invalidateActionCacheByPin(pin?: string): void {
  if (pin === undefined) {
    actionCache.clear();
    return;
  }

  for (const [address, entry] of actionCache.entries()) {
    if (entry.pin === pin) {
      actionCache.delete(address);
    }
  }
}

/**
 * Clear entire action cache.
 */
export function clearActionCache(): void {
  actionCache.clear();
}

export interface ActionLookupResult extends HorizonCheckResult {
  nextAction: WizardAction;
}

/**
 * Plain-language "what to do next", keyed by reason code.
 *
 * These strings are read by contributors who may never have used Stellar, so
 * each one names the jargon term once, in parentheses, and then explains the
 * step in ordinary words. Keep them aligned with `docs/READINESS_MODEL.md` and
 * with `READINESS_CONFIG` in `src/lib/readiness.ts` — `readiness-copy.test.ts`
 * asserts that every reason code stays reachable and consistently worded.
 */
export const WIZARD_ACTION_COPY: Record<WizardAction, string> = {
  fund_account:
    "Send at least 1 XLM to this address. A Stellar wallet does not exist until someone puts a little XLM in it, and payouts cannot reach a wallet that does not exist yet.",
  add_trustline:
    "Turn on USDC for this wallet (Stellar calls this \"adding a trustline\"). A Stellar wallet has to opt in to each kind of token before it can receive it.",
  await_trustline_authorization:
    "USDC is turned on, but the company that issues USDC has not approved this wallet yet. Wait for that approval — if it takes more than a day, contact the issuer.",
  increase_reserve:
    "Add a little more XLM. Stellar keeps a small amount locked in every wallet as a deposit, and this wallet is below the amount it needs to keep working.",
  none: "Nothing to do — this wallet can receive payouts.",
};

export function computeNextAction(
  result: Pick<
    HorizonCheckResult,
    "funded" | "trustline" | "trustline_authorized" | "readiness"
  >
): WizardAction {
  if (!result.funded) return "fund_account";
  if (!result.trustline) return "add_trustline";
  if (!result.trustline_authorized) return "await_trustline_authorization";
  if (result.readiness === "low_reserve") return "increase_reserve";
  return "none";
}

export function buildActionLookupResult(
  result: HorizonCheckResult
): ActionLookupResult {
  return {
    ...result,
    nextAction: computeNextAction(result),
  };
}
