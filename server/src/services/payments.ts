import type { Clock } from "../config.js";
import { tx, type DB } from "../db.js";
import { ApiError } from "../errors.js";
import type { Commit, StoredResult } from "../idempotency.js";
import type { PaymentWebhookEvent } from "../dto.js";
import {
  expireStaleOrders,
  getOrderRow,
  getOwnedOrder,
  reReserveStock,
  toPaymentIntentDTO,
  transition,
  type OrderRow,
  type PaymentIntentRow,
} from "./orders.js";

/** The slice of a payment provider (Razorpay/Stripe/mock) this service depends on. */
export interface PaymentProvider {
  createIntent(
    input: { amount: number; currency: string; orderId: string },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
}

function assertPayable(order: OrderRow, now: number): void {
  switch (order.status) {
    case "PAID":
      throw new ApiError(409, "order_already_paid", "This order is already paid");
    case "NEEDS_REVIEW":
      throw new ApiError(409, "order_under_review", "This order is on hold for review; contact support");
    case "EXPIRED":
      throw new ApiError(409, "order_expired", "The stock hold expired; please place the order again");
  }
  if (order.reservation_expires_at <= now) {
    throw new ApiError(409, "order_expired", "The stock hold expired; please place the order again");
  }
}

function findOpenIntent(db: DB, orderId: string): PaymentIntentRow | undefined {
  return db
    .prepare("SELECT * FROM payment_intents WHERE order_id = ? AND status = 'requires_payment'")
    .get(orderId) as PaymentIntentRow | undefined;
}

function intentResponse(status: number, intent: PaymentIntentRow): StoredResult {
  return {
    status,
    body: {
      paymentIntent: toPaymentIntentDTO(intent),
      // In production this would be the provider's checkout handle (e.g. a Razorpay order id).
      nextAction: { type: "mock_provider_confirm", url: `/mock-provider/intents/${intent.id}/confirm` },
    },
  };
}

/**
 * POST /orders/:id/payment-intents
 *
 * An order has at most one open intent at a time. If one already exists we
 * return it (200) instead of creating a second, because two live intents are
 * how a shopper gets charged twice. A partial unique index enforces the same
 * rule in the DB.
 *
 * The provider call happens outside any DB transaction (it's network I/O in
 * real life). We pass a deterministic idempotency key to the provider, so if
 * we crash after the provider call and the client retries, the provider gives
 * back the same intent instead of creating another.
 */
export async function startPayment(
  db: DB,
  clock: Clock,
  provider: PaymentProvider,
  customerId: string,
  orderId: string,
  idempotencyKey: string,
  commit: Commit,
): Promise<StoredResult> {
  expireStaleOrders(db, clock, orderId);
  const order = getOwnedOrder(db, customerId, orderId);
  assertPayable(order, clock());

  const existing = findOpenIntent(db, orderId);
  if (existing) return commit(() => intentResponse(200, existing));

  const providerIntent = await provider.createIntent(
    { amount: order.total_paise, currency: order.currency, orderId },
    `${customerId}:${idempotencyKey}`,
  );

  return commit(() => {
    // The world may have moved while we awaited the provider: re-check everything.
    const fresh = getOrderRow(db, orderId)!;
    assertPayable(fresh, clock());
    const raced = findOpenIntent(db, orderId);
    if (raced) return intentResponse(200, raced); // the provider intent we just made stays unused and harmless

    const now = clock();
    db.prepare(
      `INSERT INTO payment_intents (id, order_id, amount_paise, status, created_at, updated_at)
       VALUES (?, ?, ?, 'requires_payment', ?, ?)`,
    ).run(providerIntent.id, orderId, fresh.total_paise, now, now);
    if (fresh.status === "PAYMENT_FAILED") transition(db, clock, fresh, "PENDING_PAYMENT", "payment_retry");

    return intentResponse(201, findOpenIntent(db, orderId)!);
  });
}

export type WebhookOutcome =
  | "duplicate_event"
  | "order_paid"
  | "order_payment_failed"
  | "needs_review_amount_mismatch"
  | "needs_review_paid_after_expiry"
  | "refund_required_already_paid"
  | "stale_failure_ignored"
  | "intent_already_final"
  | "ignored_unknown_intent"
  | "ignored_order_mismatch"
  | "ignored_unhandled_type";

/**
 * Applies one verified provider event. Everything, including recording the
 * event id, happens in one transaction:
 *  - A replay or concurrent duplicate fails the INSERT on webhook_events and
 *    becomes a no-op ("duplicate_event").
 *  - If processing throws, the event row rolls back with it, so the
 *    provider's retry is processed instead of being silently dropped.
 */
export function applyPaymentEvent(db: DB, clock: Clock, event: PaymentWebhookEvent): WebhookOutcome {
  return tx(db, () => {
    const now = clock();
    const fresh = db
      .prepare(
        `INSERT INTO webhook_events (event_id, type, payment_intent_id, received_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(event.id, event.type, event.data.paymentIntentId, now).changes === 1;
    if (!fresh) return "duplicate_event";

    const outcome = settle(db, clock, event);
    db.prepare("UPDATE webhook_events SET outcome = ? WHERE event_id = ?").run(outcome, event.id);
    return outcome;
  });
}

function settle(db: DB, clock: Clock, event: PaymentWebhookEvent): WebhookOutcome {
  if (event.type !== "payment.succeeded" && event.type !== "payment.failed") return "ignored_unhandled_type";

  const intent = db
    .prepare("SELECT * FROM payment_intents WHERE id = ?")
    .get(event.data.paymentIntentId) as PaymentIntentRow | undefined;
  if (!intent) return "ignored_unknown_intent";
  // Signed, but pointing at another order: never trust the payload over our own records.
  if (intent.order_id !== event.data.orderId) return "ignored_order_mismatch";
  // A second, different event for an intent that already settled (e.g. failed after succeeded).
  if (intent.status !== "requires_payment") return "intent_already_final";

  const order = getOrderRow(db, intent.order_id)!;
  const setIntent = (status: PaymentIntentRow["status"], failureReason: string | null = null) =>
    db
      .prepare(
        "UPDATE payment_intents SET status = ?, amount_received_paise = ?, failure_reason = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, event.data.amountReceived, failureReason, clock(), intent.id);

  if (event.type === "payment.failed") {
    setIntent("failed", event.data.failureReason ?? "declined");
    // Only the order's latest attempt may fail the order, and never once it is paid.
    const latest = db
      .prepare("SELECT id FROM payment_intents WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(order.id) as { id: string };
    if (latest.id !== intent.id || order.status !== "PENDING_PAYMENT") return "stale_failure_ignored";
    transition(db, clock, order, "PAYMENT_FAILED", event.data.failureReason ?? "payment_declined");
    return "order_payment_failed";
  }

  // payment.succeeded: money moved. From here on we must never lose track of it.
  if (order.status === "PAID") {
    setIntent("refund_required", "order_already_paid");
    return "refund_required_already_paid";
  }
  if (event.data.amountReceived !== intent.amount_paise) {
    // Partial capture or over-capture: don't ship, don't release stock, hand it to ops.
    setIntent("amount_mismatch", `received ${event.data.amountReceived} of ${intent.amount_paise}`);
    transition(db, clock, order, "NEEDS_REVIEW", "amount_mismatch");
    return "needs_review_amount_mismatch";
  }
  if (!reReserveStock(db, order)) {
    // Paid after the hold expired and the units have since sold to someone else.
    setIntent("refund_required", "stock_unavailable_after_expiry");
    transition(db, clock, order, "NEEDS_REVIEW", "paid_after_expiry_out_of_stock");
    return "needs_review_paid_after_expiry";
  }
  setIntent("succeeded");
  transition(db, clock, order, "PAID", order.status === "EXPIRED" ? "paid_after_expiry" : "payment_captured");
  return "order_paid";
}
