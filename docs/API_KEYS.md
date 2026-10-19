# API Keys

Maintainers can create short-lived API keys that gate treasury export automation
and other privileged operations without sharing GitHub credentials.

← Back to [ARCHITECTURE.md](./ARCHITECTURE.md) | [README](../README.md)

---

## Overview

| Route | Method | Guard | Purpose |
|-------|--------|-------|---------|
| `/api/settings/api-keys` | `GET` | Maintainer session | List all keys (no raw value) |
| `/api/settings/api-keys` | `POST` | Maintainer session + CSRF | Create key — raw value returned once |
| `/api/settings/api-keys/[id]` | `DELETE` | Maintainer session + CSRF | Revoke key (soft delete) |

---

## Key lifecycle

```
Create → raw key shown once → stored as SHA-256 hash only
         ↓
      Active (revokedAt = null)
         ↓
      Revoke → revokedAt = now()   ← soft delete, row retained for audit
```

The raw key is **never stored**. Only its SHA-256 hex digest (`keyHash`) is
persisted in the `ApiKey` table. If a key is lost after creation it cannot be
recovered — create a new one and revoke the old one.

---

## Scopes

| Scope | Description |
|-------|-------------|
| `treasury:read` | Read treasury balances and contributor readiness |
| `treasury:export` | Download the Wave payout CSV |
| `contributors:read` | Read contributor registrations |
| `contributors:write` | Trigger re-checks and batch operations |

Scopes are stored as a `String[]` column on the `ApiKey` row and validated
server-side against `VALID_SCOPES` in `src/app/api/settings/api-keys/route.ts`.
An invalid scope in the `POST` body returns `400`.

---

## UI — ApiKeyPanel

`src/components/ApiKeyPanel.tsx` renders on the maintainer settings page.

### Test IDs (data-testid)

| testid | Element |
|--------|---------|
| `api-key-panel` | Root card |
| `maintainer-only-message` | Message shown to non-maintainers |
| `raw-key-banner` | One-time secret reveal banner |
| `raw-key-value` | `<code>` containing the raw key |
| `copy-raw-key-button` | Clipboard copy button |
| `dismiss-raw-key-button` | Banner dismiss button |
| `create-api-key-form` | Create form wrapper |
| `api-key-name-input` | Name text input |
| `scope-checkboxes` | Scope checkbox group wrapper |
| `scope-checkbox-{scope}` | Individual scope checkbox (e.g. `scope-checkbox-treasury:read`) |
| `create-api-key-button` | Submit button |
| `create-error` | Inline create error message |
| `api-key-list` | Existing keys list wrapper |
| `api-key-row-{id}` | Individual key row |
| `revoke-button-{id}` | Revoke button on an active key |
| `revoked-badge-{id}` | "Revoked" badge on a revoked key |
| `revoke-error` | Inline revoke error message |

---

## Security notes

- **One-time disclosure** — the raw key is returned in `POST` response body
  exactly once and never stored; it cannot be retrieved from the API afterwards.
- **Hash storage** — `ApiKey.keyHash` is a SHA-256 hex digest. It cannot be
  reversed to obtain the raw key.
- **Soft delete** — `DELETE` sets `revokedAt`; the row is retained for audit.
  Hard deletes are not supported through the API.
- **Maintainer-only** — all three endpoints verify `session.user.isMaintainer`.
  A non-maintainer (including an unauthenticated request) receives `403`.
- **CSRF** — `POST` and `DELETE` routes call `assertSameOrigin()` before
  touching the session.

---

## Database model

```prisma
model ApiKey {
  id        String    @id @default(cuid())
  name      String
  keyHash   String    @unique   // SHA-256 hex digest
  scopes    String[]
  createdAt DateTime  @default(now())
  revokedAt DateTime?           // null = active, non-null = revoked
}
```

---

## Testing

Tests live in `src/components/ApiKeyPanel.test.tsx` and cover:

- `GET` — 403 for unauthenticated / non-maintainer, 200 with key list for maintainer
- `POST` — CSRF guard, 403 for non-maintainer, 400 for missing name, 400 for
  invalid scope, 201 with `rawKey` present exactly once, hash stored not plaintext
- `DELETE` — CSRF guard, 403 for non-maintainer, 404 for missing id, 409 for
  already-revoked, 200 soft-delete with `revokedAt` set

Run with:

```bash
npm test
# or target just this file:
npx vitest run src/components/ApiKeyPanel.test.tsx
```
# Maintainer API Keys

← Back to [README](../README.md) · See also [Environment variables](./ENVIRONMENT.md) · [Architecture](./ARCHITECTURE.md)

---

## Why API keys?

Scheduled export jobs (cron, CI pipelines, treasury automation) need to call the contributor export endpoints without a human GitHub OAuth session. Forwarding a session cookie to a cron job is:

- **Fragile** — the cookie expires when the maintainer's session does.
- **Over-privileged** — a session carries the maintainer's full identity and all GitHub permissions.
- **Unauditable** — there is no way to distinguish a human export from an automated one in the audit log.

API keys solve all three problems: they are long-lived, scoped to the minimum required permission (`export:read`), and produce a distinct `actorLogin` (`api-key:<name>`) in every audit log entry.

---

## Security model

| Property | Detail |
|---|---|
| **Raw key** | Shown once at creation. Never stored in the database, never logged. |
| **Storage** | Only the SHA-256 hex digest (`keyHash`) is persisted in the `ApiKey` table. |
| **Key format** | `tb_<43 url-safe base64 chars>` (~258 bits of entropy from `crypto.randomBytes(32)`). |
| **Scope** | `export:read` — read-only access to `/api/contributors/export/*`. |
| **Expiry** | Optional ISO-8601 datetime. Expired keys are rejected at the DB lookup step. |
| **Revocation** | Soft-delete (`revokedAt` timestamp set on DELETE). Effective on the next request — no propagation delay. |
| **Rate limiting** | 60 requests per 60 seconds per source IP (in-process sliding window). Returns `429` with `RateLimit-*` / `Retry-After` headers. |
| **Max keys** | 10 active (non-revoked) keys per maintainer. Keeps credential inventory manageable. |
| **Audit trail** | `api_key.created`, `api_key.revoked`, `api_key.use_rejected` written to `AuditLog` on every relevant event. |
| **Plaintext guard** | `isValidApiKeyFormat()` rejects malformed values before the DB round-trip. |

### Scope bitmask

Scopes are submitted and stored as named strings (for example, `scopes: ["export:read"]`). Authorization maps those names to a bitmask so scope checks are composable; the database and API response remain string arrays.

| Scope | Bit | Mask | Permission |
|---|---:|---:|---|
| `export:read` | 0 | `1` (`0b0001`) | Read `/api/contributors/export/*`; no write access |

Bits are zero-based and masks are powers of two (`1 << bit`). Unknown scope names grant no permissions and are rejected when creating keys. The wildcard `*` is reserved for internal authorization use and cannot be created through the management API. New scopes must be assigned the next unused bit and added to the shared scope definitions before they are exposed.

> The rate limiter is in-process. On multi-instance deployments the effective limit is `N × 60` where N is the number of running instances. This is noted in `ENVIRONMENT.md` and acceptable for abuse prevention.

---

## Creating a key

### Via the settings UI

1. Go to `/dashboard/settings` (requires `operator` or `admin` role).
2. Find the **API keys** card.
3. Enter a descriptive name (e.g. `nightly-export-cron`) and click **Create key**.
  The scope badge tooltip shows its bit and mask; currently all UI-created keys use `export:read` (bit 0, mask 1).
4. Copy the secret from the green banner — it will **not** be shown again.
5. Store it in your CI/CD secret store (e.g. GitHub Actions secrets).

### Via the API (curl)

```bash
curl -X POST https://your-deployment.vercel.app/api/settings/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=<your-session-cookie>" \
  -d '{"name": "nightly-export-cron", "scopes": ["export:read"]}'
```

Response (201):

```json
{
  "key": {
    "id": "cuid...",
    "name": "nightly-export-cron",
    "scopes": ["export:read"],
    "createdAt": "2026-09-25T00:00:00.000Z",
    "expiresAt": null,
    "secret": "tb_Abc123..."
  },
  "warning": "Store this secret now — it will not be shown again."
}
```

> The `secret` field appears only in this response. Subsequent `GET /api/settings/api-keys` requests return metadata only — no secret.

#### Optional: set an expiry

```bash
-d '{"name": "quarterly-audit", "scopes": ["export:read"], "expiresAt": "2027-01-01T00:00:00Z"}'
```

---

## Using a key

Pass the key as a `Bearer` token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer tb_Abc123..." \
  https://your-deployment.vercel.app/api/contributors/export/csv \
  -o contributors.csv
```

### GitHub Actions example

```yaml
name: Nightly treasury export

on:
  schedule:
    - cron: "0 2 * * *"   # 02:00 UTC daily

jobs:
  export:
    runs-on: ubuntu-latest
    steps:
      - name: Download contributor CSV
        run: |
          curl \
            --fail \
            --retry 3 \
            --retry-delay 30 \
            -H "Authorization: Bearer ${{ secrets.TRUSTBRIDGE_API_KEY }}" \
            "${{ vars.TRUSTBRIDGE_URL }}/api/contributors/export/csv" \
            -o contributors.csv

      - name: Upload as artifact
        uses: actions/upload-artifact@v4
        with:
          name: contributors-${{ github.run_id }}
          path: contributors.csv
          retention-days: 30
```

Store the secret as `TRUSTBRIDGE_API_KEY` in your repository secrets (Settings → Secrets and variables → Actions). The URL as a repository variable is optional but keeps workflows environment-agnostic.

---

## Endpoints protected by `export:read`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/contributors/export/csv` | Download contributors as CSV |
| `GET` | `/api/contributors/export/json` | Download contributors as JSON |

Both endpoints accept either a maintainer browser session **or** a valid `export:read` API key. A request with neither receives `401 Unauthorized`.

---

## Listing and revoking keys

### List active keys

```bash
GET /api/settings/api-keys
Authorization: Cookie (operator+ session required)
```

Returns the caller's non-revoked keys with metadata (no secret):

```json
{
  "keys": [
    {
      "id": "cuid...",
      "name": "nightly-export-cron",
      "scopes": ["export:read"],
      "createdAt": "2026-09-25T00:00:00.000Z",
      "expiresAt": null,
      "lastUsedAt": "2026-09-25T02:00:05.123Z"
    }
  ]
}
```

### Revoke a key

```bash
DELETE /api/settings/api-keys/<id>
Authorization: Cookie (operator+ session required)
```

- Sets `revokedAt` immediately. The key stops working on the next request.
- Returns `409 Conflict` if the key is already revoked.
- Returns `403 Forbidden` if the key belongs to a different user.
- The UI shows a confirmation dialog before sending the request.

A revocation is always written to `AuditLog` with `action: "api_key.revoked"`.

---

## Audit log entries

All key lifecycle events appear in `/api/audit` (visible in the **Recent activity** section of `/dashboard/settings`):

| `action` | When |
|---|---|
| `api_key.created` | Key was successfully created. `metadata` includes `scopes` and `expiresAt`. |
| `api_key.revoked` | Key was revoked by its owner. `targetLabel` is the key name. |
| `api_key.revoke_denied` | A maintainer attempted to revoke a key owned by another user. |
| `api_key.use_rejected` | An incoming request was rejected. `metadata.reason` is one of `revoked`, `expired`, or `insufficient_scope`. |

`actorLogin` for authenticated export requests is `api-key:<key-name>`, making automated exports easy to identify and filter in the audit log.

---

## Error responses

| Status | Body | Meaning |
|--------|------|---------|
| `401` | `{"error":"Unauthorized"}` | No valid session and no valid API key |
| `403` | `{"error":"Forbidden"}` | Session present but insufficient role (management endpoints) |
| `404` | `{"error":"Not found"}` | Key ID not found (revoke endpoint) |
| `409` | `{"error":"Key is already revoked"}` | Revoke attempted on an already-revoked key |
| `422` | `{"error":"Validation failed","details":{...}}` | Invalid request body (create endpoint) |
| `422` | `{"error":"Maximum of 10 active API keys reached..."}` | Key limit exceeded |
| `429` | `{"error":"Too many requests"}` | IP rate limit exceeded; see `Retry-After` header |

---

## Rotating a key

API keys cannot be re-generated — only revoked and replaced. To rotate:

1. Create a new key in the settings UI or via API.
2. Copy and store the new secret in your CI/CD environment.
3. Update workflows / cron jobs to use the new secret.
4. Verify the new key works (run a test export or wait for the next scheduled run).
5. Revoke the old key.

Keeping the old key active until the new one is confirmed working prevents downtime during rotation.

---

## Database schema

The `ApiKey` model (migration `20260925000000_add_api_key_model`):

```sql
CREATE TABLE "ApiKey" (
    "id"              TEXT PRIMARY KEY,
    "maintainerOrgId" TEXT NOT NULL DEFAULT 'default',
    "keyHash"         TEXT NOT NULL UNIQUE,   -- SHA-256 hex; never the raw key
    "name"            TEXT NOT NULL,
    "scopes"          TEXT[] NOT NULL DEFAULT '{}',
    "createdById"     TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
    "expiresAt"       TIMESTAMP(3),
    "lastUsedAt"      TIMESTAMP(3),
    "revokedAt"       TIMESTAMP(3),           -- NULL = active
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Indexes: `keyHash` (unique, used for O(1) auth lookup), `createdById`, `createdAt`.

---

## Implementation files

| File | Purpose |
|------|---------|
| `src/lib/api-key-crypto.ts` | `generateApiKey()`, `hashApiKey()`, `isValidApiKeyFormat()` |
| `src/lib/api-key-auth.ts` | `requireApiKeyScope()` — extracts bearer token, hashes, queries DB, checks lifecycle + scope, applies rate limit, updates `lastUsedAt` |
| `src/app/api/settings/api-keys/route.ts` | `GET` (list) and `POST` (create) |
| `src/app/api/settings/api-keys/[id]/route.ts` | `DELETE` (revoke) |
| `src/app/api/contributors/export/csv/route.ts` | Updated to accept session **or** API key |
| `src/app/api/contributors/export/json/route.ts` | Updated to accept session **or** API key |
| `src/components/ApiKeyPanel.tsx` | Settings UI — create form, secret banner, key list, revoke button |
| `prisma/migrations/20260925000000_add_api_key_model/` | Migration SQL |
| `tests/unit/api-key-crypto.test.ts` | Unit tests for crypto utilities |
| `tests/api/api-keys.test.ts` | API handler tests for management routes |
| `tests/api/export.test.ts` | Updated — covers API key auth path on export routes |


---

## API Key Rotation Procedures (Operator Guide)

### Overview

API key rotation is a critical security procedure that should be performed:
- **Regularly** — every 90 days as part of standard security hygiene
- **On compromise** — immediately if a key is suspected to be leaked
- **On personnel changes** — when operators with key access leave the team
- **After security incidents** — as part of incident response procedures

### Pre-Rotation Checklist

Before rotating keys:

1. **Inventory all active keys:**
   ```bash
   curl -H "Cookie: next-auth.session-token=<session>" \
     https://your-deployment/api/settings/api-keys
   ```

2. **Identify key consumers:**
   - CI/CD pipelines (GitHub Actions, GitLab CI, etc.)
   - Cron jobs and schedulers
   - External monitoring/audit systems
   - Third-party integrations

3. **Check recent usage:**
   - Review `lastUsedAt` timestamps for each key
   - Verify `actorLogin` patterns in audit logs (`/api/audit`)
   - Confirm no keys are unexpectedly idle (might indicate broken integration)

4. **Prepare rollback plan:**
   - Document current key IDs and names
   - Ensure you can quickly revoke new keys if rotation causes issues
   - Have maintainer session access ready for emergency manual intervention

### Rotation Procedure (Zero-Downtime)

#### Step 1: Create new keys

```bash
# Create replacement key
curl -X POST https://your-deployment/api/settings/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=<session>" \
  -d '{
    "name": "nightly-export-cron-2027-Q1",
    "scopes": ["export:read"],
    "expiresAt": "2027-04-01T00:00:00Z"
  }'
```

**CRITICAL:** Copy the `secret` field from the response immediately. It will NOT be shown again.

#### Step 2: Update consumers (parallel deployment)

Do NOT revoke old keys yet. Update consumers to use the new key while old keys remain active:

**GitHub Actions:**
1. Go to repository Settings → Secrets and variables → Actions
2. Create new secret: `TRUSTBRIDGE_API_KEY_NEW`
3. Update workflow to try new key first, fall back to old:
   ```yaml
   - name: Export with new key (graceful fallback)
     run: |
       curl -f -H "Authorization: Bearer ${{ secrets.TRUSTBRIDGE_API_KEY_NEW }}" \
         "$TRUSTBRIDGE_URL/api/contributors/export/csv" -o contributors.csv || \
       curl -f -H "Authorization: Bearer ${{ secrets.TRUSTBRIDGE_API_KEY }}" \
         "$TRUSTBRIDGE_URL/api/contributors/export/csv" -o contributors.csv
   ```

**Cron jobs:**
```bash
# Update secret manager / environment
export TRUSTBRIDGE_API_KEY_NEW="tb_newkey..."

# Update script to try new key first
curl -H "Authorization: Bearer $TRUSTBRIDGE_API_KEY_NEW" ... || \
  curl -H "Authorization: Bearer $TRUSTBRIDGE_API_KEY" ...
```

#### Step 3: Verify new keys work

Monitor for 24-48 hours:

```bash
# Check new key usage in audit log
curl -H "Cookie: ..." https://your-deployment/api/audit \
  | jq '.entries[] | select(.actorLogin | startswith("api-key:nightly-export-cron-2027-Q1"))'

# Verify no new key rejections
curl -H "Cookie: ..." https://your-deployment/api/audit \
  | jq '.entries[] | select(.action == "api_key.use_rejected")'
```

#### Step 4: Revoke old keys

Once new keys are confirmed working:

```bash
# Revoke old key
curl -X DELETE https://your-deployment/api/settings/api-keys/<old-key-id> \
  -H "Cookie: next-auth.session-token=<session>"
```

**Audit verification:**
- Check audit log for `api_key.revoked` entry
- Confirm old key ID appears in revocation audit
- Monitor for any `api_key.use_rejected` with reason: "revoked" (indicates a consumer wasn't updated)

#### Step 5: Clean up fallback logic

After old keys are fully decommissioned (7-14 days):

1. Remove old secrets from secret stores
2. Remove fallback logic from scripts/workflows
3. Delete `TRUSTBRIDGE_API_KEY` (old) environment variables
4. Rename `TRUSTBRIDGE_API_KEY_NEW` → `TRUSTBRIDGE_API_KEY`

### Emergency Rotation (Immediate Revocation)

If a key is compromised:

#### Immediate actions (within 5 minutes):

```bash
# 1. Revoke compromised key immediately
curl -X DELETE https://your-deployment/api/settings/api-keys/<compromised-id> \
  -H "Cookie: <session>"

# 2. Create replacement key
curl -X POST https://your-deployment/api/settings/api-keys \
  -H "Content-Type: application/json" -H "Cookie: <session>" \
  -d '{"name":"emergency-replacement-<timestamp>","scopes":["export:read"]}'

# 3. Update critical consumers NOW (cron jobs, CI)
# 4. Check audit log for unauthorized use of compromised key
curl -H "Cookie: <session>" https://your-deployment/api/audit \
  | jq '.entries[] | select(.actorLogin == "api-key:<compromised-name>")'
```

#### Post-incident review (within 24 hours):

- Audit all API key usage in the exposure window
- Review export logs for data exfiltration indicators
- Rotate adjacent secrets (database passwords, other API keys)
- Document timeline and exposure scope for incident report
- Update runbooks and key management procedures

### Test Vector Validation

Operators can verify crypto implementation integrity using fixed test vectors:

```bash
# Run test vector validation
npm test -- tests/unit/api-key-crypto.test.ts -t "API key rotation test vectors"
```

**Test vectors** (documented in `tests/unit/api-key-crypto.test.ts`):

| Raw Key | Expected SHA-256 Hash |
|---------|----------------------|
| `tb_RotationTestVector123456789ABCDEFGH` | `2f5a15ea8beadbea32ce0332407f78c9184467aff5654b5e3147e036cbb491a9` |
| `tb_1234567` | `85ccc58191840b1640d85e4e052de1376959c2edddd2d7b0c7fb3a65656e7520` |
| `tb_A-Z_0-9_test-key-with-dashes_underscores` | `ccd197f3b2ebb7b8d528ec3f7c66a4c6f3c5f30249dee2fb17f789537b94bfb6` |

If test vectors fail after a Node.js or crypto library upgrade, **STOP** — this indicates a breaking change that will invalidate all existing keys.

### Troubleshooting

#### "Key not found" after rotation
- **Cause:** Hash mismatch between stored and computed hash
- **Fix:** Verify no whitespace/encoding issues when copying key
- **Verify:** Run `hashApiKey()` on the raw key and compare to DB `keyHash`

#### "Insufficient scope" errors
- **Cause:** New key missing required scopes
- **Fix:** Revoke and recreate key with correct scopes array

#### Consumer still using old key after revocation
- **Symptoms:** `api_key.use_rejected` with reason: "revoked"
- **Fix:** Check consumer's secret store, ensure update was deployed
- **Monitor:** `actorLogin` field in audit log shows which key is being used

#### Rate limiting during rotation testing
- **Cause:** Parallel key testing hitting IP rate limit (60/minute)
- **Fix:** Stagger tests or temporarily increase `API_KEY_RATE_LIMIT` env var
- **Note:** Rate limit is per-instance; multi-instance deployments have N× effective limit

### Audit Trail

Every rotation step generates audit log entries:

| Action | Audit Entry | Notes |
|--------|-------------|-------|
| Create new key | `api_key.created` | `metadata.scopes` lists granted permissions |
| First use of new key | Normal usage (no special entry) | `actorLogin` = `api-key:<new-name>` |
| Revoke old key | `api_key.revoked` | `targetLabel` = old key name |
| Attempt to use revoked key | `api_key.use_rejected` | `metadata.reason` = "revoked" |

Query audit log for rotation verification:

```bash
# All key lifecycle events in last 7 days
curl -H "Cookie: <session>" "https://your-deployment/api/audit?limit=200" \
  | jq '.entries[] | select(.action | startswith("api_key"))'
```

### Security Best Practices

1. **Never log raw keys** — only log key IDs or names
2. **Use expiry dates** — set `expiresAt` for non-permanent keys
3. **Scope minimization** — grant only required scopes (e.g., `export:read` not `*`)
4. **Monitor lastUsedAt** — unused keys should be revoked
5. **Audit review** — weekly review of `api_key.use_rejected` entries
6. **Separate keys per consumer** — don't share one key across multiple systems
7. **Document key purpose** — use descriptive names like `github-actions-wave-export`

### Automation

For teams with >10 keys, consider automating rotation:

```bash
#!/bin/bash
# rotate-trustbridge-keys.sh
# Run quarterly as cron job

set -euo pipefail

KEYS=$(curl -s -H "Cookie: $SESSION_COOKIE" "$TRUSTBRIDGE_URL/api/settings/api-keys" | jq -r '.keys[].id')

for key_id in $KEYS; do
  # Get key details
  key_info=$(curl -s -H "Cookie: $SESSION_COOKIE" "$TRUSTBRIDGE_URL/api/settings/api-keys" \
    | jq -r ".keys[] | select(.id == \"$key_id\")")

  # Check if key is >90 days old
  created_at=$(echo "$key_info" | jq -r '.createdAt')
  age_days=$(( ( $(date +%s) - $(date -d "$created_at" +%s) ) / 86400 ))

  if [ $age_days -gt 90 ]; then
    echo "Rotating key: $(echo "$key_info" | jq -r '.name') (age: $age_days days)"
    # TODO: Implement create-new, update-consumer, revoke-old logic
  fi
done
```

**Important:** Test automation thoroughly in staging before production deployment.

---

## References

- Crypto implementation: `src/lib/api-key-crypto.ts`
- Test vectors: `tests/unit/api-key-crypto.test.ts`
- Key management UI: `src/components/ApiKeyPanel.tsx`
- Audit logging: `src/lib/audit.ts`
- Rate limiting: `src/lib/rate-limit.ts`
