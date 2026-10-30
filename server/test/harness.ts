import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, seedIfEmpty } from "../src/db.js";
import type { PaymentWebhookEvent } from "../src/dto.js";
import { MockPayProvider } from "../src/mockProvider/mockPay.js";
import { signatureHeader, SIGNATURE_HEADER } from "../src/webhookSignature.js";

export const ALICE = "Bearer demo-token-alice";
export const BOB = "Bearer demo-token-bob";

/** A fresh in-memory app with a controllable clock and in-process webhook delivery. */
export function makeHarness() {
  let now = Date.UTC(2026, 9, 29, 10, 0, 0);
  const clock = () => now;
  const config = { ...loadConfig({}), reservationTtlMs: 15 * 60_000 };
  const db = openDb(":memory:");
  seedIfEmpty(db);

  const provider: MockPayProvider = new MockPayProvider({
    secret: config.webhookSecret,
    webhookUrl: "/webhooks/payment",
    clock,
    deliveryDelayMs: 0,
    maxAttempts: 1,
    deliver: async (url, rawBody, headers) => (await request(app).post(url).set(headers).send(rawBody)).status,
  });
  const app = createApp({ db, config, clock, provider });

  let keySeq = 0;
  const key = () => `test-key-${++keySeq}-${Math.random().toString(36).slice(2)}`;

  return {
    app,
    db,
    config,
    provider,
    advance: (ms: number) => {
      now += ms;
    },
    nowSec: () => Math.floor(now / 1000),
    key,
    stockOf: (sku: string) =>
      (db.prepare("SELECT stock FROM products WHERE sku = ?").get(sku) as { stock: number }).stock,

    createOrder: (items: { sku: string; qty: number }[], idemKey = key(), auth = ALICE) =>
      request(app).post("/orders").set("Authorization", auth).set("Idempotency-Key", idemKey).send({ items }),

    startPayment: (orderId: string, idemKey = key(), auth = ALICE) =>
      request(app)
        .post(`/orders/${orderId}/payment-intents`)
        .set("Authorization", auth)
        .set("Idempotency-Key", idemKey)
        .send(),

    getOrder: (orderId: string, auth = ALICE) => request(app).get(`/orders/${orderId}`).set("Authorization", auth),

    /** Posts a webhook signed exactly like the provider would sign it. */
    sendWebhook: (event: PaymentWebhookEvent, opts: { secret?: string; timestampSec?: number } = {}) => {
      const raw = JSON.stringify(event);
      const ts = opts.timestampSec ?? Math.floor(now / 1000);
      return request(app)
        .post("/webhooks/payment")
        .set("content-type", "application/json")
        .set(SIGNATURE_HEADER, signatureHeader(opts.secret ?? config.webhookSecret, ts, raw))
        .send(raw);
    },
  };
}

export type Harness = ReturnType<typeof makeHarness>;

/** Creates an order and an open payment intent for it. Returns both ids. */
export async function orderWithIntent(h: Harness, items = [{ sku: "BF-YOGA-MAT", qty: 1 }]) {
  const order = await h.createOrder(items);
  if (order.status !== 201) throw new Error(`createOrder failed: ${order.status} ${JSON.stringify(order.body)}`);
  const pi = await h.startPayment(order.body.id);
  if (pi.status !== 201) throw new Error(`startPayment failed: ${pi.status} ${JSON.stringify(pi.body)}`);
  return { orderId: order.body.id as string, intentId: pi.body.paymentIntent.id as string, total: order.body.total as number };
}

export function eventFor(
  h: Harness,
  p: { orderId: string; intentId: string; amount: number },
  over: Partial<PaymentWebhookEvent> & { amountReceived?: number } = {},
): PaymentWebhookEvent {
  const { amountReceived, ...rest } = over;
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    type: "payment.succeeded",
    created: h.nowSec(),
    data: {
      paymentIntentId: p.intentId,
      orderId: p.orderId,
      amount: p.amount,
      amountReceived: amountReceived ?? p.amount,
      currency: "INR",
    },
    ...rest,
  };
}
