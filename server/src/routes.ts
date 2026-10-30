import express, { Router, type Response } from "express";
import { customerIdOf, requireCustomer } from "./auth.js";
import type { Clock, Config } from "./config.js";
import type { DB } from "./db.js";
import { ConfirmMockPaymentRequest, CreateOrderRequest, PaymentWebhookEvent } from "./dto.js";
import { ApiError } from "./errors.js";
import { runIdempotent, type StoredResult } from "./idempotency.js";
import type { MockPayProvider } from "./mockProvider/mockPay.js";
import { createOrderInTx, expireStaleOrders, getOrderView, getOwnedOrder, listProducts } from "./services/orders.js";
import { applyPaymentEvent, startPayment } from "./services/payments.js";
import { SIGNATURE_HEADER, verifySignature } from "./webhookSignature.js";

export interface Deps {
  db: DB;
  config: Config;
  clock: Clock;
  provider: MockPayProvider;
}

function sendStored(res: Response, result: StoredResult & { replayed: boolean }) {
  if (result.replayed) res.set("Idempotent-Replayed", "true");
  res.status(result.status).json(result.body);
}

export function catalogRoutes({ db }: Deps): Router {
  const r = Router();
  // Public: browsing doesn't need a token.
  r.get("/products", (_req, res) => {
    res.json({ products: listProducts(db) });
  });
  return r;
}

export function orderRoutes({ db, clock, config, provider }: Deps): Router {
  const r = Router();
  r.use("/orders", requireCustomer(config.apiTokens));

  r.post("/orders", async (req, res) => {
    const body = CreateOrderRequest.parse(req.body);
    const customerId = customerIdOf(res);
    const result = await runIdempotent(
      db,
      clock,
      { customerId, key: req.get("idempotency-key"), endpoint: "POST /orders", requestBody: body },
      async (commit) =>
        commit(() => ({
          status: 201,
          body: createOrderInTx(db, clock, config.reservationTtlMs, customerId, body),
        })),
    );
    res.location(`/orders/${(result.body as { id: string }).id}`);
    sendStored(res, result);
  });

  r.get("/orders/:id", (req, res) => {
    expireStaleOrders(db, clock, req.params.id);
    getOwnedOrder(db, customerIdOf(res), req.params.id);
    res.set("Cache-Control", "no-store").json(getOrderView(db, req.params.id));
  });

  r.post("/orders/:id/payment-intents", async (req, res) => {
    const customerId = customerIdOf(res);
    const key = req.get("idempotency-key");
    const orderId = req.params.id;
    const result = await runIdempotent(
      db,
      clock,
      { customerId, key, endpoint: `POST /orders/${orderId}/payment-intents`, requestBody: {} },
      (commit) => startPayment(db, clock, provider, customerId, orderId, key!, commit),
    );
    sendStored(res, result);
  });

  return r;
}

/**
 * The provider authenticates with an HMAC signature, not a bearer token. We
 * need the exact bytes that were signed, so this route reads the raw body and
 * is mounted before the global JSON parser.
 *
 * Response codes are a contract with the provider: 2xx = acknowledged (also
 * for duplicates and events we ignore), 401 = signature rejected (don't
 * retry), 5xx = we failed, please retry.
 */
export function webhookRoutes({ db, clock, config }: Deps): Router {
  const r = Router();
  r.post("/webhooks/payment", express.raw({ type: "*/*", limit: "64kb" }), (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const verified = verifySignature({
      secret: config.webhookSecret,
      header: req.get(SIGNATURE_HEADER),
      rawBody,
      nowSec: Math.floor(clock() / 1000),
      toleranceSec: config.webhookToleranceSec,
    });
    if (!verified.ok) {
      throw new ApiError(401, "invalid_signature", "Webhook signature verification failed", { reason: verified.reason });
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new ApiError(400, "malformed_json", "Body is not valid JSON");
    }
    const event = PaymentWebhookEvent.parse(json);
    const outcome = applyPaymentEvent(db, clock, event);
    res.status(200).json({ received: true, eventId: event.id, outcome });
  });
  return r;
}

/** Simulates the provider's hosted checkout page. Turned off with MOCK_PROVIDER_ENABLED=false. */
export function mockProviderRoutes({ provider }: Deps): Router {
  const r = Router();
  r.post("/mock-provider/intents/:id/confirm", (req, res) => {
    const { outcome, duplicateDelivery } = ConfirmMockPaymentRequest.parse(req.body ?? {});
    res.status(202).json(provider.confirm(req.params.id, outcome, duplicateDelivery));
  });
  r.post("/mock-provider/events/:id/replay", (req, res) => {
    res.status(202).json(provider.replay(req.params.id));
  });
  return r;
}
