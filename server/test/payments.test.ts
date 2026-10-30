import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { BOB, eventFor, makeHarness, orderWithIntent, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});

const confirm = (intentId: string, outcome: string, duplicateDelivery = false) =>
  request(h.app).post(`/mock-provider/intents/${intentId}/confirm`).send({ outcome, duplicateDelivery });

const webhookOutcomes = () =>
  h.db.prepare("SELECT outcome FROM webhook_events ORDER BY rowid").all().map((r) => (r as { outcome: string }).outcome);

describe("payment intents", () => {
  it("happy path: intent -> provider confirms -> signed webhook -> PAID", async () => {
    const { orderId, intentId } = await orderWithIntent(h);
    expect((await confirm(intentId, "success")).status).toBe(202);
    await h.provider.idle();

    const order = (await h.getOrder(orderId)).body;
    expect(order).toMatchObject({ status: "PAID", canPay: false });
    expect(order.payments[0]).toMatchObject({ id: intentId, status: "succeeded" });
    expect(order.timeline.map((e: { to: string }) => e.to)).toEqual(["PENDING_PAYMENT", "PAID"]);
  });

  it("returns the open intent instead of creating a second one (double-click, different keys)", async () => {
    const { body: order } = await h.createOrder([{ sku: "BF-YOGA-MAT", qty: 1 }]);
    const [a, b] = await Promise.all([h.startPayment(order.id), h.startPayment(order.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.paymentIntent.id).toBe(b.body.paymentIntent.id);
  });

  it("refuses to start a payment for someone else's order or a paid order", async () => {
    const { orderId, intentId } = await orderWithIntent(h);
    expect((await h.startPayment(orderId, h.key(), BOB)).status).toBe(404);

    await confirm(intentId, "success");
    await h.provider.idle();
    const res = await h.startPayment(orderId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("order_already_paid");
  });

  it("refuses to pay an order whose stock hold expired", async () => {
    const { body: order } = await h.createOrder([{ sku: "BF-YOGA-MAT", qty: 1 }]);
    h.advance(16 * 60_000);
    const res = await h.startPayment(order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("order_expired");
  });
});

describe("POST /webhooks/payment", () => {
  it("rejects bad signatures with 401 and changes nothing", async () => {
    const p = await orderWithIntent(h);
    const res = await h.sendWebhook(eventFor(h, { ...p, amount: p.total }), { secret: "whsec_wrong" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: "invalid_signature", details: { reason: "signature_mismatch" } });
    expect((await h.getOrder(p.orderId)).body.status).toBe("PENDING_PAYMENT");
    expect(webhookOutcomes()).toEqual([]);
  });

  it("rejects unsigned and stale requests", async () => {
    const p = await orderWithIntent(h);
    const unsigned = await request(h.app)
      .post("/webhooks/payment")
      .set("content-type", "application/json")
      .send(JSON.stringify(eventFor(h, { ...p, amount: p.total })));
    expect(unsigned.status).toBe(401);

    const stale = await h.sendWebhook(eventFor(h, { ...p, amount: p.total }), { timestampSec: h.nowSec() - 600 });
    expect(stale.body.error.details.reason).toBe("timestamp_out_of_tolerance");
  });

  it("processes a duplicate delivery exactly once, even when both arrive together", async () => {
    const { orderId, intentId } = await orderWithIntent(h);
    await confirm(intentId, "success", true);
    await h.provider.idle();

    expect(webhookOutcomes()).toEqual(["order_paid"]); // one row: the second was deduped by event id
    const order = (await h.getOrder(orderId)).body;
    expect(order.status).toBe("PAID");
    expect(order.timeline).toHaveLength(2);
  });

  it("acknowledges a replay of the same event as a no-op", async () => {
    const p = await orderWithIntent(h);
    const event = eventFor(h, { ...p, amount: p.total });
    expect((await h.sendWebhook(event)).body.outcome).toBe("order_paid");
    const replay = await h.sendWebhook(event);
    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toBe("duplicate_event");
  });

  it("a later failure event cannot undo PAID", async () => {
    const p = await orderWithIntent(h);
    await h.sendWebhook(eventFor(h, { ...p, amount: p.total }));
    const late = await h.sendWebhook(eventFor(h, { ...p, amount: p.total }, { type: "payment.failed", amountReceived: 0 }));
    expect(late.body.outcome).toBe("intent_already_final");
    expect((await h.getOrder(p.orderId)).body.status).toBe("PAID");
  });

  it("failed payment -> retry with a new intent -> PAID; reservation is kept across the retry", async () => {
    const { orderId, intentId } = await orderWithIntent(h, [{ sku: "BF-RES-BANDS", qty: 3 }]);
    await confirm(intentId, "failure");
    await h.provider.idle();

    let order = (await h.getOrder(orderId)).body;
    expect(order).toMatchObject({ status: "PAYMENT_FAILED", statusReason: "card_declined", canPay: true });
    expect(h.stockOf("BF-RES-BANDS")).toBe(0); // still held for the retry

    const retry = await h.startPayment(orderId);
    expect(retry.status).toBe(201);
    expect(retry.body.paymentIntent.id).not.toBe(intentId);
    await confirm(retry.body.paymentIntent.id, "success");
    await h.provider.idle();

    order = (await h.getOrder(orderId)).body;
    expect(order.status).toBe("PAID");
    expect(order.payments.map((x: { status: string }) => x.status)).toEqual(["failed", "succeeded"]);
  });

  it("partial payment puts the order on hold for review, not PAID", async () => {
    const { orderId, intentId, total } = await orderWithIntent(h);
    await confirm(intentId, "partial");
    await h.provider.idle();

    const order = (await h.getOrder(orderId)).body;
    expect(order).toMatchObject({ status: "NEEDS_REVIEW", statusReason: "amount_mismatch", canPay: false });
    expect(order.payments[0]).toMatchObject({ status: "amount_mismatch", amountReceived: Math.floor(total / 2) });
  });

  it("late success after expiry re-reserves stock if it is still available", async () => {
    const p = await orderWithIntent(h, [{ sku: "BF-RES-BANDS", qty: 2 }]);
    h.advance(16 * 60_000);
    expect((await h.getOrder(p.orderId)).body.status).toBe("EXPIRED");
    expect(h.stockOf("BF-RES-BANDS")).toBe(3);

    const res = await h.sendWebhook(eventFor(h, { ...p, amount: p.total }));
    expect(res.body.outcome).toBe("order_paid");
    expect((await h.getOrder(p.orderId)).body).toMatchObject({ status: "PAID", statusReason: "paid_after_expiry" });
    expect(h.stockOf("BF-RES-BANDS")).toBe(1);
  });

  it("late success after expiry with stock gone -> NEEDS_REVIEW + refund_required", async () => {
    const p = await orderWithIntent(h, [{ sku: "BF-RES-BANDS", qty: 3 }]);
    h.advance(16 * 60_000);
    await h.getOrder(p.orderId); // expires, releases 3 units
    expect((await h.createOrder([{ sku: "BF-RES-BANDS", qty: 3 }], h.key(), BOB)).status).toBe(201);

    const res = await h.sendWebhook(eventFor(h, { ...p, amount: p.total }));
    expect(res.body.outcome).toBe("needs_review_paid_after_expiry");
    const order = (await h.getOrder(p.orderId)).body;
    expect(order.status).toBe("NEEDS_REVIEW");
    expect(order.payments[0].status).toBe("refund_required");
    expect(h.stockOf("BF-RES-BANDS")).toBe(0);
  });

  it("ignores events whose orderId doesn't match the intent", async () => {
    const a = await orderWithIntent(h);
    const b = await orderWithIntent(h);
    const res = await h.sendWebhook(eventFor(h, { orderId: b.orderId, intentId: a.intentId, amount: a.total }));
    expect(res.body.outcome).toBe("ignored_order_mismatch");
    expect((await h.getOrder(b.orderId)).body.status).toBe("PENDING_PAYMENT");
  });

  it("acknowledges unknown intents and event types without failing", async () => {
    const p = await orderWithIntent(h);
    expect((await h.sendWebhook(eventFor(h, { ...p, intentId: "pi_nope", amount: 1 }))).body.outcome).toBe(
      "ignored_unknown_intent",
    );
    expect((await h.sendWebhook(eventFor(h, { ...p, amount: p.total }, { type: "payment.refunded" }))).body.outcome).toBe(
      "ignored_unhandled_type",
    );
  });

  it("the provider won't confirm the same intent twice", async () => {
    const { intentId } = await orderWithIntent(h);
    expect((await confirm(intentId, "success")).status).toBe(202);
    expect((await confirm(intentId, "success")).status).toBe(409);
    await h.provider.idle();
  });
});
