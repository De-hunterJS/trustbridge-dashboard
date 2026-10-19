import { describe, expect, it } from "vitest";

import {
  describeAuditAction,
  summarizeAuditLog,
  toAuditLogEntry,
  redactAuditMetadata,
  normalizeAuditActor,
  formatAuditEntryForAdmin,
} from "@/lib/audit-format";
import type { AuditLogEntry } from "@/types";

describe("describeAuditAction", () => {
  it("returns a friendly label for known actions", () => {
    expect(describeAuditAction("recheck.single")).toBe(
      "Re-checked a contributor"
    );
    expect(describeAuditAction("export.cron")).toBe(
      "Automated nightly treasury CSV export"
    );
  });

  it("falls back to the raw action for unknown ones", () => {
    expect(describeAuditAction("mystery.action")).toBe("mystery.action");
  });
});

describe("toAuditLogEntry", () => {
  const base = {
    id: "log_1",
    actorId: "user_1",
    actorLogin: "octocat",
    action: "recheck.single",
    targetId: "reg_1",
    targetLabel: "octocat",
  };

  it("serializes a Date createdAt to ISO", () => {
    const entry = toAuditLogEntry({
      ...base,
      metadata: { readiness: "ready" },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(entry.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.metadata).toEqual({ readiness: "ready" });
  });

  it("normalizes non-object metadata to null", () => {
    const entry = toAuditLogEntry({
      ...base,
      metadata: "not-json",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(entry.metadata).toBeNull();
  });
});

describe("summarizeAuditLog", () => {
  it("counts entries by action", () => {
    const entries: AuditLogEntry[] = [
      makeEntry("recheck.single"),
      makeEntry("recheck.single"),
      makeEntry("recheck.batch"),
    ];
    expect(summarizeAuditLog(entries)).toEqual({
      total: 3,
      byAction: { "recheck.single": 2, "recheck.batch": 1 },
    });
  });
});

function makeEntry(action: string): AuditLogEntry {
  return {
    id: `log_${action}`,
    actorId: null,
    actorLogin: null,
    action,
    targetId: null,
    targetLabel: null,
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("redactAuditMetadata", () => {
  it("returns null for null or undefined metadata", () => {
    expect(redactAuditMetadata(null)).toBeNull();
    expect(redactAuditMetadata(undefined)).toBeNull();
  });

  it("redacts known secret keys", () => {
    const metadata = {
      rawKey: "tb_secret123",
      secret: "my-secret",
      token: "bearer-token",
      apiKey: "key-123",
      password: "pass123",
      safeField: "visible",
    };

    const redacted = redactAuditMetadata(metadata);

    expect(redacted).toEqual({
      rawKey: "[REDACTED]",
      secret: "[REDACTED]",
      token: "[REDACTED]",
      apiKey: "[REDACTED]",
      password: "[REDACTED]",
      safeField: "visible",
    });
  });

  it("redacts keys case-insensitively", () => {
    const metadata = {
      RawKey: "secret",
      ACCESS_TOKEN: "token",
      SafeField: "visible",
    };

    const redacted = redactAuditMetadata(metadata);

    expect(redacted).toEqual({
      RawKey: "[REDACTED]",
      ACCESS_TOKEN: "[REDACTED]",
      SafeField: "visible",
    });
  });

  it("recursively redacts nested objects", () => {
    const metadata = {
      user: {
        id: "user_123",
        apiKey: "secret-key",
        profile: {
          name: "Alice",
          password: "hidden",
        },
      },
      safeField: "visible",
    };

    const redacted = redactAuditMetadata(metadata);

    expect(redacted).toEqual({
      user: {
        id: "user_123",
        apiKey: "[REDACTED]",
        profile: {
          name: "Alice",
          password: "[REDACTED]",
        },
      },
      safeField: "visible",
    });
  });

  it("preserves arrays and primitive values", () => {
    const metadata = {
      scopes: ["read", "write"],
      count: 42,
      enabled: true,
      token: "secret",
    };

    const redacted = redactAuditMetadata(metadata);

    expect(redacted).toEqual({
      scopes: ["read", "write"],
      count: 42,
      enabled: true,
      token: "[REDACTED]",
    });
  });

  it("redacts keyHash even though it's hashed", () => {
    const metadata = {
      keyHash: "abc123def456",
      userId: "user_789",
    };

    const redacted = redactAuditMetadata(metadata);

    expect(redacted).toEqual({
      keyHash: "[REDACTED]",
      userId: "user_789",
    });
  });
});

describe("normalizeAuditActor", () => {
  it("identifies system actions", () => {
    const entry = makeEntry("system.cron");

    const actor = normalizeAuditActor(entry);

    expect(actor).toEqual({
      actorType: "system",
      displayName: "System",
      actorId: null,
    });
  });

  it("identifies API key actions", () => {
    const entry: AuditLogEntry = {
      ...makeEntry("export.csv"),
      actorId: "key_123",
      actorLogin: "api-key:nightly-export",
    };

    const actor = normalizeAuditActor(entry);

    expect(actor).toEqual({
      actorType: "api_key",
      displayName: "API Key: nightly-export",
      actorId: "key_123",
    });
  });

  it("identifies user actions with login", () => {
    const entry: AuditLogEntry = {
      ...makeEntry("recheck.single"),
      actorId: "user_123",
      actorLogin: "octocat",
    };

    const actor = normalizeAuditActor(entry);

    expect(actor).toEqual({
      actorType: "user",
      displayName: "octocat",
      actorId: "user_123",
    });
  });

  it("handles user actions with only actorId", () => {
    const entry: AuditLogEntry = {
      ...makeEntry("recheck.single"),
      actorId: "user_123",
      actorLogin: null,
    };

    const actor = normalizeAuditActor(entry);

    expect(actor).toEqual({
      actorType: "user",
      displayName: "user_123",
      actorId: "user_123",
    });
  });

  it("handles malformed actor data gracefully", () => {
    const entry: AuditLogEntry = {
      ...makeEntry("unknown.action"),
      actorId: null,
      actorLogin: null,
    };

    const actor = normalizeAuditActor(entry);

    expect(actor.actorType).toBe("system");
  });
});

describe("formatAuditEntryForAdmin", () => {
  it("combines redaction and normalization (happy path)", () => {
    const entry: AuditLogEntry = {
      id: "log_123",
      actorId: "user_456",
      actorLogin: "octocat",
      action: "api_key.created",
      targetId: "key_789",
      targetLabel: "My API Key",
      metadata: {
        scopes: ["export:read"],
        rawKey: "tb_secret123",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const formatted = formatAuditEntryForAdmin(entry);

    expect(formatted).toEqual({
      id: "log_123",
      actorId: "user_456",
      actorLogin: "octocat",
      action: "api_key.created",
      targetId: "key_789",
      targetLabel: "My API Key",
      metadata: {
        scopes: ["export:read"],
        rawKey: "[REDACTED]",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      actor: {
        actorType: "user",
        displayName: "octocat",
        actorId: "user_456",
      },
    });
  });

  it("masks secrets in API key use_rejected events (failure path)", () => {
    const entry: AuditLogEntry = {
      id: "log_456",
      actorId: "key_123",
      actorLogin: "api-key:compromised-key",
      action: "api_key.use_rejected",
      targetId: "key_123",
      targetLabel: "compromised-key",
      metadata: {
        reason: "revoked",
        token: "bearer-leaked-token",
        timestamp: "2026-01-01T12:00:00Z",
      },
      createdAt: "2026-01-01T12:00:00.000Z",
    };

    const formatted = formatAuditEntryForAdmin(entry);

    expect(formatted.metadata).toEqual({
      reason: "revoked",
      token: "[REDACTED]",
      timestamp: "2026-01-01T12:00:00Z",
    });
    expect(formatted.actor.actorType).toBe("api_key");
    expect(formatted.actor.displayName).toBe("API Key: compromised-key");
  });
});
