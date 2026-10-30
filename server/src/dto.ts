import { z } from "zod";
import type { OrderStatus } from "./domain/orderStateMachine.js";

// ---- Requests ---------------------------------------------------------------

export const CreateOrderRequest = z
  .object({
    items: z
      .array(
        z
          .object({
            sku: z.string().trim().min(1).max(64),
            qty: z.number().int().min(1).max(10),
          })
          .strict(),
      )
      .min(1, "Cart is empty")
      .max(20),
  })
  .strict();
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

export const ConfirmMockPaymentRequest = z
  .object({
    outcome: z.enum(["success", "failure", "partial"]),
    /** Deliver the same signed event twice, at the same time, to exercise dedupe. */
    duplicateDelivery: z.boolean().optional(),
  })
  .strict();

/** Envelope the mock provider sends to POST /webhooks/payment. */
export const PaymentWebhookEvent = z.object({
  id: z.string().min(1).max(128),
  type: z.string().min(1),
  created: z.number().int(),
  data: z.object({
    paymentIntentId: z.string().min(1),
    orderId: z.string().min(1),
    amount: z.number().int().nonnegative(),
    amountReceived: z.number().int().nonnegative(),
    currency: z.string().length(3),
    failureReason: z.string().optional(),
  }),
});
export type PaymentWebhookEvent = z.infer<typeof PaymentWebhookEvent>;

// ---- Responses --------------------------------------------------------------
// Prices are integer minor units (paise) to avoid floating-point money.

export interface ProductDTO {
  sku: string;
  name: string;
  description: string;
  category: string;
  price: number;
  currency: "INR";
  stock: number;
  inStock: boolean;
}

export interface OrderItemDTO {
  sku: string;
  name: string;
  unitPrice: number;
  qty: number;
  lineTotal: number;
}

export type PaymentIntentStatus =
  | "requires_payment"
  | "succeeded"
  | "failed"
  | "amount_mismatch"
  | "refund_required";

export interface PaymentIntentDTO {
  id: string;
  orderId: string;
  amount: number;
  amountReceived: number | null;
  currency: "INR";
  status: PaymentIntentStatus;
  failureReason: string | null;
  createdAt: string;
}

export interface OrderEventDTO {
  from: OrderStatus | null;
  to: OrderStatus;
  reason: string | null;
  at: string;
}

export interface OrderDTO {
  id: string;
  status: OrderStatus;
  statusReason: string | null;
  items: OrderItemDTO[];
  total: number;
  currency: "INR";
  reservationExpiresAt: string;
  /** True when the client may call POST /orders/:id/payment-intents. */
  canPay: boolean;
  payments: PaymentIntentDTO[];
  timeline: OrderEventDTO[];
  createdAt: string;
  updatedAt: string;
}
