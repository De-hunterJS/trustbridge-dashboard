import { describe, expect, it } from "vitest";

import {
  generateApiKey,
  hashApiKey,
  isValidApiKeyFormat,
} from "@/lib/api-key-crypto";

/**
 * Unit tests for API key cryptography utilities.
 *
 * Tests verify:
 * - Key generation format and entropy characteristics
 * - Hash determinism and uniqueness
 * - Format validation (prefix, minimum length)
 * - Rotation test vectors for operational readiness
 *
 * Watch for: raw keys in assertions (use length/prefix checks, not full value),
 * hash collisions (not tested exhaustively — rely on SHA-256 properties).
 */

/**
 * Fixed test vectors for API key rotation procedures.
 * These vectors are used to verify crypto implementation stability across versions.
 *
 * CRITICAL: These test vectors must never change. They validate that:
 * 1. Hash function remains consistent across Node.js/crypto versions
 * 2. Key format stays compatible with existing persisted hashes
 * 3. Operators can verify rotation procedure correctness
 *
 * Changing these vectors indicates a breaking crypto change that requires
 * database migration and emergency key rotation for all active keys.
 */
export const API_KEY_ROTATION_TEST_VECTORS = [
  {
    description: "Example key for operator rotation testing",
    rawKey: "tb_RotationTestVector123456789ABCDEFGH",
    expectedHash:
      "2f5a15ea8beadbea32ce0332407f78c9184467aff5654b5e3147e036cbb491a9",
  },
  {
    description: "Minimum length key",
    rawKey: "tb_1234567", // exactly 10 chars
    expectedHash:
      "85ccc58191840b1640d85e4e052de1376959c2edddd2d7b0c7fb3a65656e7520",
  },
  {
    description: "Key with URL-safe base64 characters",
    rawKey: "tb_A-Z_0-9_test-key-with-dashes_underscores",
    expectedHash:
      "ccd197f3b2ebb7b8d528ec3f7c66a4c6f3c5f30249dee2fb17f789537b94bfb6",
  },
] as const;

describe("generateApiKey", () => {
  it("produces a string with the tb_ prefix", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^tb_/);
  });

  it("produces a key of at least 44 characters", () => {
    // "tb_" (3) + base64url of 32 bytes (43 chars) = 46 minimum
    const key = generateApiKey();
    expect(key.length).toBeGreaterThanOrEqual(44);
  });

  it("generates unique keys on each call", () => {
    const keys = new Set(Array.from({ length: 100 }, generateApiKey));
    expect(keys.size).toBe(100);
  });

  it("uses only URL-safe characters after the prefix", () => {
    const key = generateApiKey();
    const suffix = key.slice(3); // strip "tb_"
    expect(suffix).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("hashApiKey", () => {
  it("returns a lowercase hex string of 64 characters (SHA-256)", () => {
    const hash = hashApiKey("tb_some-key");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    const raw = generateApiKey();
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
  });

  it("produces different hashes for different inputs", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(hashApiKey(a)).not.toBe(hashApiKey(b));
  });

  it("is sensitive to a single character difference", () => {
    const base = "tb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const diff = "tb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
    expect(hashApiKey(base)).not.toBe(hashApiKey(diff));
  });

  it("never returns the raw key in the hash output", () => {
    const raw = generateApiKey();
    const hash = hashApiKey(raw);
    expect(hash).not.toContain(raw);
    expect(hash).not.toContain(raw.slice(3)); // strip prefix too
  });
});

describe("isValidApiKeyFormat", () => {
  it("accepts a generated key", () => {
    expect(isValidApiKeyFormat(generateApiKey())).toBe(true);
  });

  it("rejects a key without the tb_ prefix", () => {
    expect(isValidApiKeyFormat("no_prefix_key_12345")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidApiKeyFormat("")).toBe(false);
  });

  it("rejects a key that is too short", () => {
    expect(isValidApiKeyFormat("tb_")).toBe(false);
    expect(isValidApiKeyFormat("tb_abc")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidApiKeyFormat(null as unknown as string)).toBe(false);
    expect(isValidApiKeyFormat(undefined as unknown as string)).toBe(false);
    expect(isValidApiKeyFormat(123 as unknown as string)).toBe(false);
  });

  it("accepts a key of exactly 10 characters", () => {
    // "tb_" (3) + 7 chars = 10 total — minimum valid length
    expect(isValidApiKeyFormat("tb_1234567")).toBe(true);
  });
});

describe("API key rotation test vectors", () => {
  it("validates fixed test vectors for operational rotation procedures", () => {
    // These test vectors are documented in docs/API_KEYS.md for operators
    for (const vector of API_KEY_ROTATION_TEST_VECTORS) {
      const actualHash = hashApiKey(vector.rawKey);

      expect(actualHash).toBe(vector.expectedHash);
      expect(isValidApiKeyFormat(vector.rawKey)).toBe(true);
    }
  });

  it("ensures test vectors never produce the same hash", () => {
    const hashes = new Set(
      API_KEY_ROTATION_TEST_VECTORS.map((v) => hashApiKey(v.rawKey))
    );

    expect(hashes.size).toBe(API_KEY_ROTATION_TEST_VECTORS.length);
  });

  it("validates minimum length vector is accepted", () => {
    const minLengthVector = API_KEY_ROTATION_TEST_VECTORS.find(
      (v) => v.description === "Minimum length key"
    );

    expect(minLengthVector).toBeDefined();
    expect(minLengthVector!.rawKey).toHaveLength(10);
    expect(isValidApiKeyFormat(minLengthVector!.rawKey)).toBe(true);
  });

  it("test vectors remain stable across crypto library versions", () => {
    // This test exists to catch unintentional hash changes from Node.js upgrades
    const knownStableHash = API_KEY_ROTATION_TEST_VECTORS[0].expectedHash;

    // Re-hash the same key
    const recomputedHash = hashApiKey(API_KEY_ROTATION_TEST_VECTORS[0].rawKey);

    expect(recomputedHash).toBe(knownStableHash);
  });
});
