/**
 * Fires hand-crafted webhooks at a running server to poke edge cases.
 *
 *   npm run webhook -w server -- <scenario> <orderId>
 *
 * Scenarios:
 *   success   valid signed payment.succeeded for the order's latest intent
 *   fail      valid signed payment.failed
 *   partial   payment.succeeded with half the amount
 *   replay    the same signed event sent twice in a row (second -> duplicate_event)
 *   race      the same signed event sent 5x concurrently (exactly one applies)
 *   tampered  valid signature, then the body is altered (-> 401 signature_mismatch)
 *   stale     signed 10 minutes ago (-> 401 timestamp_out_of_tolerance)
 */
import { randomUUID } from "node:crypto";
import { signatureHeader, SIGNATURE_HEADER } from "../src/webhookSignature.js";

const BASE = process.env.API_URL ?? "http://localhost:4000";
const SECRET = process.env.WEBHOOK_SECRET ?? "whsec_local_dev_only";
const TOKEN = process.env.API_TOKEN ?? "demo-token-alice";

const [scenario, orderId] = process.argv.slice(2);
if (!scenario || !orderId) {
  console.error("usage: send-webhook <success|fail|partial|replay|race|tampered|stale> <orderId>");
  process.exit(1);
}

const orderRes = await fetch(`${BASE}/orders/${orderId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
if (!orderRes.ok) throw new Error(`GET order failed: ${orderRes.status} ${await orderRes.text()}`);
const order = (await orderRes.json()) as { payments: { id: string; amount: number }[] };
const intent = order.payments.at(-1);
if (!intent) throw new Error("Order has no payment intent yet. Start a payment in the UI first.");

const now = Math.floor(Date.now() / 1000);
const event = {
  id: `evt_cli_${randomUUID().slice(0, 8)}`,
  type: scenario === "fail" ? "payment.failed" : "payment.succeeded",
  created: now,
  data: {
    paymentIntentId: intent.id,
    orderId,
    amount: intent.amount,
    amountReceived: scenario === "fail" ? 0 : scenario === "partial" ? Math.floor(intent.amount / 2) : intent.amount,
    currency: "INR",
    ...(scenario === "fail" ? { failureReason: "card_declined" } : {}),
  },
};

const raw = JSON.stringify(event);
const ts = scenario === "stale" ? now - 600 : now;
const header = signatureHeader(SECRET, ts, raw);
const body = scenario === "tampered" ? raw.replace(`"amountReceived":${intent.amount}`, `"amountReceived":1`) : raw;

async function send(label: string) {
  const res = await fetch(`${BASE}/webhooks/payment`, {
    method: "POST",
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: header },
    body,
  });
  console.log(`${label.padEnd(10)} ${res.status} ${await res.text()}`);
}

if (scenario === "replay") {
  await send("first");
  await send("replay");
} else if (scenario === "race") {
  await Promise.all([1, 2, 3, 4, 5].map((n) => send(`race #${n}`)));
} else {
  await send(scenario);
}
