import { describe, expect, it } from "vitest";
import { computeSignature, signatureHeader, verifySignature } from "../src/webhookSignature.js";

const secret = "whsec_test";
const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "payment.succeeded" }));
const now = 1_800_000_000;
const verify = (header: string | undefined, rawBody = body, nowSec = now) =>
  verifySignature({ secret, header, rawBody, nowSec, toleranceSec: 300 });

describe("verifySignature", () => {
  it("accepts a correctly signed, fresh payload", () => {
    expect(verify(signatureHeader(secret, now, body))).toEqual({ ok: true, timestampSec: now });
  });

  it("rejects a body modified after signing", () => {
    const tampered = Buffer.from(body.toString().replace("succeeded", "failed"));
    expect(verify(signatureHeader(secret, now, body), tampered)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a signature made with another secret", () => {
    expect(verify(signatureHeader("whsec_attacker", now, body))).toMatchObject({ reason: "signature_mismatch" });
  });

  it("rejects a captured request replayed after the tolerance window", () => {
    const header = signatureHeader(secret, now, body);
    expect(verify(header, body, now + 301)).toMatchObject({ reason: "timestamp_out_of_tolerance" });
  });

  it("rejects a fresh timestamp swapped onto an old signature", () => {
    const oldSig = computeSignature(secret, now - 3600, body);
    expect(verify(`t=${now},v1=${oldSig}`)).toMatchObject({ reason: "signature_mismatch" });
  });

  it("rejects missing and malformed headers", () => {
    expect(verify(undefined)).toMatchObject({ reason: "missing_header" });
    expect(verify("garbage")).toMatchObject({ reason: "malformed_header" });
    expect(verify(`t=${now},v1=nothex`)).toMatchObject({ reason: "malformed_header" });
  });

  it("accepts any matching v1 entry, to allow secret rotation", () => {
    const good = computeSignature(secret, now, body);
    expect(verify(`t=${now},v1=${"0".repeat(64)},v1=${good}`).ok).toBe(true);
  });
});
