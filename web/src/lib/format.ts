const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

/** Paise -> "₹2,499". */
export const formatMoney = (paise: number) => inr.format(paise / 100);

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** "14:05" style countdown from milliseconds. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const newIdempotencyKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** snake_case reason codes from the API -> readable sentence fragments. */
export function humanize(code: string | null | undefined): string {
  if (!code) return "";
  const known: Record<string, string> = {
    card_declined: "Your card was declined",
    amount_mismatch: "We received a different amount than the order total",
    reservation_expired: "The 15-minute stock hold ran out",
    paid_after_expiry: "Payment arrived after the hold expired, and stock was still available",
    paid_after_expiry_out_of_stock: "Payment arrived after the hold expired and the items had sold out",
    payment_captured: "Payment captured",
    payment_retry: "Retrying payment",
    order_created: "Order placed, stock reserved",
  };
  return known[code] ?? code.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}
