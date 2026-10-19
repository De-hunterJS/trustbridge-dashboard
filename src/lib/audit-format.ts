import type { AuditLogEntry } from "@/types";

/**
 * List of metadata keys that should always be masked in audit views.
 * Extend this list when new secret-containing fields are added to audit metadata.
 */
const SECRET_METADATA_KEYS = [
  "rawKey",
  "secret",
  "token",
  "apiKey",
  "password",
  "privateKey",
  "accessToken",
  "refreshToken",
  "keyHash", // While hashed, still sensitive
] as const;

/**
 * Redact sensitive values from audit metadata.
 * Returns a new object with secret fields masked.
 */
export function redactAuditMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object") return null;

  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    const lowerKey = key.toLowerCase();
    const isSecret = SECRET_METADATA_KEYS.some((secretKey) =>
      lowerKey.includes(secretKey.toLowerCase())
    );

    if (isSecret) {
      redacted[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      // Recursively redact nested objects
      redacted[key] = redactAuditMetadata(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Normalize actor fields for consistent display in audit views.
 * Handles system actions (no actor), API key actions, and user actions.
 */
export function normalizeAuditActor(entry: AuditLogEntry): {
  actorType: "system" | "api_key" | "user";
  displayName: string;
  actorId: string | null;
} {
  // System action (no actor)
  if (!entry.actorId && !entry.actorLogin) {
    return {
      actorType: "system",
      displayName: "System",
      actorId: null,
    };
  }

  // API key action (actorLogin format: "api-key:<name>")
  if (entry.actorLogin?.startsWith("api-key:")) {
    const keyName = entry.actorLogin.slice(8); // strip "api-key:" prefix
    return {
      actorType: "api_key",
      displayName: `API Key: ${keyName}`,
      actorId: entry.actorId,
    };
  }

  // User action
  return {
    actorType: "user",
    displayName: entry.actorLogin ?? entry.actorId ?? "Unknown",
    actorId: entry.actorId,
  };
}

/**
 * Prepare an audit log entry for display in admin views.
 * Redacts secrets and normalizes actor fields.
 */
export function formatAuditEntryForAdmin(
  entry: AuditLogEntry
): AuditLogEntry & { actor: ReturnType<typeof normalizeAuditActor> } {
  return {
    ...entry,
    metadata: redactAuditMetadata(entry.metadata),
    actor: normalizeAuditActor(entry),
  };
}

/** Human-readable labels for known audit actions. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "recheck.single": "Re-checked a contributor",
  "recheck.batch": "Re-checked all contributors",
  "registration.create": "Registered a Stellar address",
  "registration.update": "Updated a Stellar address",
  "registration.delete": "Soft-deleted a registration",
  "registration.restore": "Restored a registration",
  network_config_mismatch_detected: "Detected a Horizon/Soroban network mismatch",
  "contract.sync": "Synced Soroban contract registrations",
  "export.csv": "Exported contributors CSV",
  "export.csv.failed": "Failed to export contributors CSV",
  "export.cron": "Automated nightly treasury CSV export",
  "export.cron.failed": "Automated nightly treasury CSV export failed",
  "export.json": "Exported contributors JSON",
  "export.json.failed": "Failed to export contributors JSON",
  "api_key.created": "Created an API key",
  "api_key.revoked": "Revoked an API key",
  "api_key.use_rejected": "API key use rejected",
  "digest.cron": "Scheduled contributor readiness digest sent",
  "digest.cron.failed": "Scheduled contributor readiness digest failed",
};

export function describeAuditAction(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/**
 * Shape of a persisted audit row (a subset of the Prisma model). Kept local so
 * this module stays free of `server-only`/Prisma imports and remains testable.
 */
export interface AuditLogRowLike {
  id: string;
  actorId: string | null;
  actorLogin: string | null;
  action: string;
  targetId: string | null;
  targetLabel: string | null;
  metadata: unknown;
  createdAt: Date | string;
}

/** Map a persisted row to the serializable API entry. */
export function toAuditLogEntry(row: AuditLogRowLike): AuditLogEntry {
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString();

  return {
    id: row.id,
    actorId: row.actorId,
    actorLogin: row.actorLogin,
    action: row.action,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : null,
    createdAt,
  };
}

export interface AuditLogSummary {
  total: number;
  byAction: Record<string, number>;
}

export function summarizeAuditLog(entries: AuditLogEntry[]): AuditLogSummary {
  const byAction: Record<string, number> = {};
  for (const entry of entries) {
    byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
  }
  return { total: entries.length, byAction };
}
