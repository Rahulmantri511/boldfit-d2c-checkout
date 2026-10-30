export const ORDER_STATUSES = [
  "PENDING_PAYMENT",
  "PAYMENT_FAILED",
  "PAID",
  "NEEDS_REVIEW",
  "EXPIRED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The only legal order transitions.
 *
 *   PENDING_PAYMENT ──success──▶ PAID
 *        │  ▲  └──amount mismatch──▶ NEEDS_REVIEW
 *   fail │  │ retry
 *        ▼  │
 *   PAYMENT_FAILED ──reservation TTL──▶ EXPIRED ──late success──▶ PAID / NEEDS_REVIEW
 *
 * Rule of thumb: once the provider confirms money for a not-yet-paid order,
 * that wins, so PAYMENT_FAILED and EXPIRED can still go to PAID. A failure
 * event can never undo PAID. PAID and NEEDS_REVIEW are terminal here;
 * refunds and fulfilment would live in their own flows.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ["PAID", "PAYMENT_FAILED", "NEEDS_REVIEW", "EXPIRED"],
  PAYMENT_FAILED: ["PENDING_PAYMENT", "PAID", "NEEDS_REVIEW", "EXPIRED"],
  EXPIRED: ["PAID", "NEEDS_REVIEW"],
  PAID: [],
  NEEDS_REVIEW: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses in which the order still holds a stock reservation that can expire. */
export const RESERVATION_HOLDING: readonly OrderStatus[] = ["PENDING_PAYMENT", "PAYMENT_FAILED"];

/** Statuses from which the customer may (re)start a payment. */
export const PAYABLE: readonly OrderStatus[] = ["PENDING_PAYMENT", "PAYMENT_FAILED"];
