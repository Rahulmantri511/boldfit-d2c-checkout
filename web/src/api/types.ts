// Mirrors server/src/dto.ts. Money is integer paise.

export type OrderStatus = "PENDING_PAYMENT" | "PAYMENT_FAILED" | "PAID" | "NEEDS_REVIEW" | "EXPIRED";
export type PaymentIntentStatus = "requires_payment" | "succeeded" | "failed" | "amount_mismatch" | "refund_required";
export type MockOutcome = "success" | "failure" | "partial";

export interface Product {
  sku: string;
  name: string;
  description: string;
  category: string;
  price: number;
  currency: "INR";
  stock: number;
  inStock: boolean;
}

export interface OrderItem {
  sku: string;
  name: string;
  unitPrice: number;
  qty: number;
  lineTotal: number;
}

export interface PaymentIntent {
  id: string;
  orderId: string;
  amount: number;
  amountReceived: number | null;
  currency: "INR";
  status: PaymentIntentStatus;
  failureReason: string | null;
  createdAt: string;
}

export interface OrderEvent {
  from: OrderStatus | null;
  to: OrderStatus;
  reason: string | null;
  at: string;
}

export interface Order {
  id: string;
  status: OrderStatus;
  statusReason: string | null;
  items: OrderItem[];
  total: number;
  currency: "INR";
  reservationExpiresAt: string;
  canPay: boolean;
  payments: PaymentIntent[];
  timeline: OrderEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface StartPaymentResponse {
  paymentIntent: PaymentIntent;
  nextAction: { type: "mock_provider_confirm"; url: string };
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
