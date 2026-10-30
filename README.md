# Boldfit D2C checkout slice

A small checkout flow: **catalog → cart → order with stock reservation → payment intent → mock provider → HMAC-signed webhook → order status page**.

The focus is on what goes wrong in payments: double-submits, racing for the last unit, webhook replays and duplicates, declined and partial payments, and money that arrives after the stock hold expired.

| | |
|---|---|
| **Backend** | Node 22+ · TypeScript · Express 5 · SQLite via built-in `node:sqlite` (no native build) · zod |
| **Frontend** | React 19 · TypeScript · Vite · react-router |
| **Tests** | Vitest + Supertest (41 API tests), Vitest + Testing Library (8 UI tests) |

## Run it

```bash
npm install
npm run dev          # API on :4000, web on http://localhost:5173
npm test             # server + web test suites
npm run typecheck
```

Requires **Node ≥ 22.13** (for `node:sqlite`). No Docker, no external services, no credentials. The SQLite file is created at `server/data/checkout.db` and seeded with 5 SKUs. Delete the file to reset.

**Try the edge cases in the UI.** The MockPay sheet lets you choose **success / decline / partial capture**, and has a toggle to **deliver the webhook twice at the same time**. *Resistance Bands* has 3 units (to test the stock race) and *Gym Gloves* is sold out.

**Or fire webhooks by hand** at an order that already has a payment intent:

```bash
npm run webhook -w server -- race     <orderId>   # same signed event 5x concurrently -> 1 applied, 4 duplicate_event
npm run webhook -w server -- tampered <orderId>   # -> 401 signature_mismatch
npm run webhook -w server -- stale    <orderId>   # -> 401 timestamp_out_of_tolerance
npm run webhook -w server -- partial  <orderId>   # -> NEEDS_REVIEW
```

## API

The auth header is `Authorization: Bearer demo-token-alice` (or `demo-token-bob`). The tokens are hardcoded, as the brief allows. Every order query is scoped to the token's customer id, so switching to real auth only touches [`auth.ts`](server/src/auth.ts).

| Method & path | Auth | Notes |
|---|---|---|
| `GET /products` | public | Prices in integer **paise**, live stock |
| `POST /orders` | bearer + **`Idempotency-Key`** | Body is `{ items: [{ sku, qty }] }`. The client never sends prices. Returns **201** with `Location`. A replay returns the stored 201 with `Idempotent-Replayed: true` |
| `GET /orders/:id` | bearer | Order, items, payment attempts, status timeline. Another customer's order gives **404**, not 403 |
| `POST /orders/:id/payment-intents` | bearer + **`Idempotency-Key`** | **201** for a new intent. **200** returns the order's existing open intent |
| `POST /webhooks/payment` | **HMAC** (`X-MockPay-Signature: t=…,v1=…`) | 200 = acknowledged (including duplicates and ignored events), 401 = bad signature, 5xx = provider should retry |
| `POST /mock-provider/intents/:id/confirm` | dev only | Simulates the provider's hosted checkout page |

Errors always look like `{ "error": { "code", "message", "details?" } }`.

| Status | When |
|---|---|
| 400 | Schema or JSON invalid, missing or malformed `Idempotency-Key` |
| 401 | Missing or invalid bearer token, bad webhook signature |
| 404 | Not found, or not yours |
| 409 | `insufficient_stock` (with per-SKU `requested`/`available`), `order_already_paid`, `order_expired`, `idempotency_request_in_progress` |
| 422 | `unknown_sku`, `idempotency_key_reused` (same key, different body) |

### Order lifecycle

```
PENDING_PAYMENT ──success──▶ PAID
     │  ▲   └──amount ≠ total──▶ NEEDS_REVIEW
fail │  │ retry (new intent)
     ▼  │
PAYMENT_FAILED ──15 min hold lapses──▶ EXPIRED ──late success──▶ PAID (if restock works) / NEEDS_REVIEW (refund)
```

Allowed transitions live in one table ([`orderStateMachine.ts`](server/src/domain/orderStateMachine.ts)). Every status change is a compare-and-set `UPDATE … WHERE status = <expected>` and is written to an `order_events` audit table, which the UI shows as the timeline.

## Edge cases handled

| Case | What happens | Where |
|---|---|---|
| Double-click / retried POST | `Idempotency-Key` per customer. The claim is an atomic INSERT, the response is saved **in the same transaction** as the order, and replays get the stored response. A concurrent duplicate gets 409 *in progress* | [`idempotency.ts:43`](server/src/idempotency.ts#L43) |
| Same key, different body | 422 `idempotency_key_reused` (the key is bound to a body hash and an endpoint) | [`idempotency.ts`](server/src/idempotency.ts) |
| Stock race for the last unit | Conditional decrement `UPDATE … SET stock = stock - n WHERE stock >= n`, plus a `CHECK (stock >= 0)` backstop. The test fires 8 concurrent buyers at 3 units: 3 win, 5 get 409 | [`orders.ts:94`](server/src/services/orders.ts#L94) |
| Multi-line cart, one line short | All-or-nothing: the whole transaction rolls back, and the 409 lists every short SKU | [`orders.ts`](server/src/services/orders.ts) |
| Client tampers with price | Strict schema rejects unknown fields. Prices are read from the DB and snapshotted onto the order | [`dto.ts`](server/src/dto.ts) |
| Two live intents → double charge | At most one open intent per order. It's reused, and a **partial unique index** enforces it in the DB | [`payments.ts:69`](server/src/services/payments.ts#L69), [`db.ts:62`](server/src/db.ts#L62) |
| Forged or tampered webhook | HMAC-SHA256 over `timestamp.rawBody`, compared in constant time on the raw bytes (route mounted before the JSON parser) | [`webhookSignature.ts:23`](server/src/webhookSignature.ts#L23) |
| Captured webhook replayed later | Signed timestamp with ±5 min tolerance | same |
| Duplicate or concurrent delivery | `webhook_events.event_id` primary key, inserted **in the same transaction** as the state change. A replay is a 200 no-op. If processing fails, the event row rolls back too, so the provider's retry isn't lost | [`payments.ts:129`](server/src/services/payments.ts#L129) |
| Out-of-order events (fail after success) | An intent that's already settled ignores later events, and a failure can never undo PAID | [`payments.ts:146`](server/src/services/payments.ts#L146) |
| Stale failure from an older attempt | Only the latest intent can move the order to PAYMENT_FAILED | same |
| Partial capture / amount mismatch | Order goes to **NEEDS_REVIEW** (not PAID, not shipped). Stock stays reserved for ops to resolve | [`payments.ts:182`](server/src/services/payments.ts#L182) |
| Paid twice | Second capture → intent marked `refund_required`, order stays PAID | [`payments.ts:178`](server/src/services/payments.ts#L178) |
| Unpaid order holds stock forever | 15 min hold. A sweeper runs every 15 s **and** reads/payment attempts expire lazily. Stock is released exactly once (`stock_released` flag) | [`orders.ts:212`](server/src/services/orders.ts#L212) |
| Payment arrives after the hold expired | Re-reserve stock (all-or-nothing via SAVEPOINT) → PAID. If it sold out meanwhile → NEEDS_REVIEW + `refund_required` | [`orders.ts:190`](server/src/services/orders.ts#L190) |
| Webhook slow or lost | UI keeps polling and, after 20 s, tells the shopper it's slow and that they won't be charged twice. The mock provider retries 5xx with exponential backoff | [`OrderPage.tsx`](web/src/pages/OrderPage.tsx), [`mockPay.ts`](server/src/mockProvider/mockPay.ts) |
| Network error at checkout | UI keeps the same idempotency key per cart revision, so "Try again" can't create a second order (UI test covers it) | [`CheckoutPage.tsx`](web/src/pages/CheckoutPage.tsx) |
| Crash mid-request | An unfinished idempotency claim older than 60 s can be taken over. The provider gets a deterministic idempotency key, so a retry reuses the provider's intent | [`idempotency.ts:81`](server/src/idempotency.ts#L81) |

## Design decisions

**1. Webhook is the source of truth; the client only polls our API.** The browser never tells us "payment succeeded". It confirms on the provider's page, and the order only changes when a signed webhook arrives. The order page polls `GET /orders/:id` (every 1 s while a webhook is expected, every 5 s while unpaid, stopped once final). *Rejected:* trusting a client-side success callback (spoofable, and lost if the tab closes), and polling the provider from the server (more API calls and rate limits, and you need webhooks for async methods like UPI anyway). With more time I'd add a **reconciliation job** that polls the provider for intents that have been open for over N minutes, as a fallback for lost webhooks.

**2. Reserve stock when the order is created, with a 15-minute hold.** *Rejected:* decrementing stock when payment succeeds. That's simpler, but two shoppers can both pay for the last unit and one needs a refund: bad UX, and it costs money. The cost of reserving is that abandoned carts lock stock, hence the TTL and the sweeper. A declined payment **keeps** the hold so the retry can't fail on stock. A late success after expiry tries to re-reserve before marking PAID.

**3. Idempotency keys are saved in the same transaction as the business writes, scoped per customer.** The key row is claimed first (an atomic INSERT works as a lock), and the response is written in the **same transaction** as the order. A crash can't leave an order without its saved key, or the reverse. Only successes are cached. Failed requests roll back completely, so retrying the same key after a 409 (e.g. once stock is fixed) works. *Rejected:* an in-memory key cache (lost on restart, wrong with more than one instance), and caching 4xx responses Stripe-style (a stale 409 would stick to the key). Keys are generated by the client: one per cart revision for checkout, and `pay-{orderId}-{settledAttempts}` for payments. A retry of the same attempt reuses its key, and a new attempt after a decline gets a new one, with nothing stored on the client.

**Failure mode I'd demo: duplicate and concurrent webhook delivery.** Turn on "send the webhook twice at once" in MockPay, or run `npm run webhook -w server -- race <orderId>`. Both deliveries pass signature checks. The `INSERT … ON CONFLICT DO NOTHING` on `webhook_events` inside the processing transaction makes exactly one of them apply; the other returns `200 duplicate_event`. Code: [`applyPaymentEvent`](server/src/services/payments.ts#L129). Tests: *"processes a duplicate delivery exactly once"* and *"acknowledges a replay"* in [`payments.test.ts`](server/test/payments.test.ts).

**What I changed after the first pass.** (a) I first did the provider call inside the DB transaction. With a real network call that means a long transaction, and with `node:sqlite` another request's statements would end up inside *our* open transaction. I split it into claim → async provider call → `commit()` that re-checks the order. (b) I added the partial unique index on open intents once I saw that two concurrent "Pay" clicks with *different* keys could otherwise create two intents. (c) I **cut** a separate refunds flow and an admin review screen: `NEEDS_REVIEW` / `refund_required` mark the cases, and an ops tool would act on them. With more time I'd redo money as a proper `Money` value type and generate the frontend DTO types from the zod schemas instead of mirroring them by hand.

**Week 2, if this shipped to real shoppers.** Swap MockPay for Razorpay behind the same `PaymentProvider` interface (orders API + `payment.captured`/`payment.failed` webhooks, secret rotation using multiple `v1` signatures, which the verifier already accepts), and add the reconciliation job above so a lost webhook can never leave a paid order stuck in PENDING. Move SQLite to Postgres. The conditional-decrement and compare-and-set queries carry over unchanged, and the idempotency claim becomes `INSERT … ON CONFLICT` on a unique index. Then put alerts on the signals that mean money is at risk (`NEEDS_REVIEW` count, `refund_required` intents, webhook 401 rate, age of the oldest PENDING order with a confirmed payment), add structured logs keyed by `orderId`/`eventId`, and add real customer auth (OTP/JWT) behind the existing `requireCustomer` seam. Finally, a load test of the hot SKU path before the first sale drop.

## Assumptions

- Single currency (INR). Money is integer paise everywhere. Free shipping, no tax lines.
- Max 10 units per line and 20 lines per order (validated on both server and client).
- One shopper token is wired into the web app (`VITE_API_TOKEN`). Bob's token exists to show ownership checks.
- The mock provider runs in-process but behaves like a third party: it has its own state, honours its own idempotency keys, and delivers signed webhooks over real HTTP with retry and backoff.
- SQLite + a single process is enough for the slice. Within one process, `node:sqlite` is synchronous, so each transaction runs without interleaving. The *queries* are still written to be race-safe on a multi-instance Postgres setup (conditional updates, compare-and-set, unique constraints), not to rely on that.

## Bonus: "retry failed payment" with human approval

[`docs/retry-failed-payment.schema.json`](docs/retry-failed-payment.schema.json) is a JSON Schema (with an example) that an internal agent fills in to *propose* a retry. Key choices:
- `approval.approvedBy` must be a human and differ from `proposedBy`.
- `preconditions` capture what the agent saw (status, amount, number of attempts). The executor re-checks them at run time and refuses if the order has changed.
- `requestId` doubles as the `Idempotency-Key` for the payment-intent call, so a double approval can't create two intents.
- `expiresAt` makes approvals go stale.

## Layout

```
server/src
  app.ts, routes.ts            HTTP wiring (webhook route mounted before express.json for raw body)
  auth.ts                      bearer token → customer id
  idempotency.ts               Idempotency-Key claim / commit / replay
  webhookSignature.ts          HMAC sign / verify
  domain/orderStateMachine.ts  allowed transitions
  services/orders.ts           create + reserve, expiry, compare-and-set transitions, views
  services/payments.ts         start payment, apply webhook event
  mockProvider/mockPay.ts      fake Razorpay: intents, signed delivery, retries
server/test                    API + signature tests (in-memory DB, controllable clock)
server/scripts/send-webhook.ts CLI to fire edge-case webhooks
web/src
  pages/                       Catalog, Checkout, Order status
  components/MockPaySheet.tsx  stand-in for the provider's hosted checkout
  cart/cart.tsx                SKU → qty reducer (no prices on the client)
```
