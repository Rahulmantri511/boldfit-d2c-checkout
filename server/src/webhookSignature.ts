import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Header format (Stripe-style):  X-MockPay-Signature: t=<unix seconds>,v1=<hex hmac>
 * The signed string is `${t}.${rawBody}`. Signing the timestamp too means an
 * attacker can't replay an old body with a new timestamp, and the tolerance
 * window limits how long a captured request can be replayed.
 */
export const SIGNATURE_HEADER = "x-mockpay-signature";

export function computeSignature(secret: string, timestampSec: number, rawBody: string | Buffer): string {
  return createHmac("sha256", secret).update(`${timestampSec}.`).update(rawBody).digest("hex");
}

export function signatureHeader(secret: string, timestampSec: number, rawBody: string | Buffer): string {
  return `t=${timestampSec},v1=${computeSignature(secret, timestampSec, rawBody)}`;
}

export type VerifyResult =
  | { ok: true; timestampSec: number }
  | { ok: false; reason: "missing_header" | "malformed_header" | "timestamp_out_of_tolerance" | "signature_mismatch" };

export function verifySignature(opts: {
  secret: string;
  header: string | undefined;
  rawBody: Buffer;
  nowSec: number;
  toleranceSec: number;
}): VerifyResult {
  if (!opts.header) return { ok: false, reason: "missing_header" };

  let timestampSec: number | undefined;
  const candidates: string[] = [];
  for (const part of opts.header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) timestampSec = Number(v);
    // Several v1 entries may be present while a secret is being rotated.
    if (k === "v1" && v && /^[0-9a-f]{64}$/.test(v)) candidates.push(v);
  }
  if (timestampSec === undefined || candidates.length === 0) return { ok: false, reason: "malformed_header" };

  if (Math.abs(opts.nowSec - timestampSec) > opts.toleranceSec) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = Buffer.from(computeSignature(opts.secret, timestampSec, opts.rawBody), "hex");
  const matched = candidates.some((c) => timingSafeEqual(Buffer.from(c, "hex"), expected));
  return matched ? { ok: true, timestampSec } : { ok: false, reason: "signature_mismatch" };
}
