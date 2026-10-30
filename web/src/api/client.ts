import type { ApiErrorBody, MockOutcome, Order, Product, StartPaymentResponse } from "./types";

const BASE = "/api";
// A hardcoded demo token, as the brief allows. A real app would get this from its auth/session layer.
const TOKEN = import.meta.env.VITE_API_TOKEN ?? "demo-token-alice";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
  /** Network failures and 5xx are safe to retry with the same idempotency key. */
  get retryable() {
    return this.status === 0 || this.status >= 500 || this.code === "idempotency_request_in_progress";
  }
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string; auth?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.auth !== false) headers.Authorization = `Bearer ${TOKEN}`;
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Couldn't reach the server. Check your connection and try again.");
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = (json as ApiErrorBody | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return json as T;
}

export const api = {
  listProducts: (signal?: AbortSignal) =>
    request<{ products: Product[] }>("/products", { auth: false, signal }).then((r) => r.products),

  createOrder: (items: { sku: string; qty: number }[], idempotencyKey: string) =>
    request<Order>("/orders", { method: "POST", body: { items }, idempotencyKey }),

  getOrder: (id: string, signal?: AbortSignal) => request<Order>(`/orders/${encodeURIComponent(id)}`, { signal }),

  startPayment: (orderId: string, idempotencyKey: string) =>
    request<StartPaymentResponse>(`/orders/${encodeURIComponent(orderId)}/payment-intents`, {
      method: "POST",
      idempotencyKey,
    }),

  /** Stands in for the provider's hosted checkout (Razorpay/Stripe would render their own UI). */
  confirmMockPayment: (url: string, outcome: MockOutcome, duplicateDelivery: boolean) =>
    request<{ id: string; status: string; eventId: string }>(url, {
      method: "POST",
      body: { outcome, duplicateDelivery },
      auth: false,
    }),
};
