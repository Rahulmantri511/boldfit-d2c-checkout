import { createHash } from "node:crypto";
import type { Clock } from "./config.js";
import { tx, type DB } from "./db.js";
import { ApiError } from "./errors.js";

export interface StoredResult {
  status: number;
  body: unknown;
}

export interface IdempotencyContext {
  customerId: string;
  key: string | undefined;
  /** e.g. "POST /orders". A key is bound to one endpoint. */
  endpoint: string;
  requestBody: unknown;
}

/**
 * Runs the business writes and saves the response in the same transaction,
 * so a crash can never leave an order behind without its key saved (or a
 * saved key without its order).
 */
export type Commit = (writes: () => StoredResult) => StoredResult;

const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
/** An unfinished claim older than this is treated as abandoned (process died mid-request). */
const STALE_CLAIM_MS = 60_000;

/**
 * Stripe-style Idempotency-Key handling for mutations.
 *
 * 1. Claim (customer, key) with an INSERT. The primary key makes the claim
 *    atomic, so a concurrent duplicate sees the row and gets 409.
 * 2. The handler does any slow or async work (e.g. calling the provider), then
 *    calls commit(), which does the DB writes and saves the response.
 * 3. Replays with the same key and body get the saved response back. The same
 *    key with a different body is rejected.
 *
 * Only successful results are stored. A failed request rolls back completely,
 * so the claim is released and the client can retry with the same key.
 */
export async function runIdempotent(
  db: DB,
  clock: Clock,
  ctx: IdempotencyContext,
  handler: (commit: Commit) => Promise<StoredResult>,
): Promise<StoredResult & { replayed: boolean }> {
  const { customerId, key, endpoint } = ctx;
  if (!key) {
    throw new ApiError(400, "idempotency_key_required", "Idempotency-Key header is required for this request");
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ApiError(400, "idempotency_key_invalid", "Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-:.]");
  }
  const requestHash = hashBody(ctx.requestBody);
  const now = clock();

  const claimed = db
    .prepare(
      `INSERT INTO idempotency_keys (customer_id, idem_key, endpoint, request_hash, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(customerId, key, endpoint, requestHash, now).changes === 1;

  if (!claimed) {
    const existing = db
      .prepare("SELECT * FROM idempotency_keys WHERE customer_id = ? AND idem_key = ?")
      .get(customerId, key) as unknown as IdemRow;

    if (existing.endpoint !== endpoint || existing.request_hash !== requestHash) {
      throw new ApiError(
        422,
        "idempotency_key_reused",
        "This Idempotency-Key was already used with a different request",
      );
    }
    if (existing.status_code !== null) {
      return { status: existing.status_code, body: JSON.parse(existing.response_body!), replayed: true };
    }
    const tookOverStaleClaim =
      existing.created_at < now - STALE_CLAIM_MS &&
      db
        .prepare(
          `UPDATE idempotency_keys SET created_at = ?
           WHERE customer_id = ? AND idem_key = ? AND status_code IS NULL AND created_at = ?`,
        )
        .run(now, customerId, key, existing.created_at).changes === 1;
    if (!tookOverStaleClaim) {
      throw new ApiError(409, "idempotency_request_in_progress", "A request with this Idempotency-Key is still in progress");
    }
  }

  const commit: Commit = (writes) =>
    tx(db, () => {
      const result = writes();
      db.prepare(
        `UPDATE idempotency_keys SET status_code = ?, response_body = ?
         WHERE customer_id = ? AND idem_key = ?`,
      ).run(result.status, JSON.stringify(result.body), customerId, key);
      return result;
    });

  try {
    const result = await handler(commit);
    return { ...result, replayed: false };
  } catch (err) {
    db.prepare(
      "DELETE FROM idempotency_keys WHERE customer_id = ? AND idem_key = ? AND status_code IS NULL",
    ).run(customerId, key);
    throw err;
  }
}

interface IdemRow {
  endpoint: string;
  request_hash: string;
  status_code: number | null;
  response_body: string | null;
  created_at: number;
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(stableStringify(body ?? null)).digest("hex");
}

/** JSON.stringify with sorted object keys, so {a,b} and {b,a} hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
