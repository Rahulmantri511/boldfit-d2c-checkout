import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { MockOutcome, Order, OrderStatus, StartPaymentResponse } from "../api/types";
import { MockPaySheet } from "../components/MockPaySheet";
import { ErrorBlock, LoadingBlock, Spinner } from "../components/States";
import { Confetti, StatusBadge, type Tone } from "../components/StatusBadge";
import { formatCountdown, formatMoney, formatTime, humanize } from "../lib/format";

/** How long we wait for the webhook before telling the shopper it's slow (we still keep polling). */
const SLOW_CONFIRMATION_MS = 20_000;

const STATUS_COPY: Record<OrderStatus, { title: string; tone: Tone }> = {
  PENDING_PAYMENT: { title: "Awaiting payment", tone: "pending" },
  PAYMENT_FAILED: { title: "Payment failed", tone: "failed" },
  PAID: { title: "Order confirmed", tone: "paid" },
  NEEDS_REVIEW: { title: "On hold", tone: "review" },
  EXPIRED: { title: "Order expired", tone: "expired" },
};

export function OrderPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [startingPayment, setStartingPayment] = useState(false);
  const [sheet, setSheet] = useState<StartPaymentResponse | null>(null);
  /** Set when the provider accepted the payment and we're waiting for its webhook. */
  const [awaitingSince, setAwaitingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** The tone the page first loaded with. Status animations only play for changes after that. */
  const firstTone = useRef<Tone | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const o = await api.getOrder(id, signal);
        setOrder(o);
        setLoadError(null);
        return o;
      } catch (err) {
        if ((err as Error).name !== "AbortError") setLoadError(err as ApiError);
        return null;
      }
    },
    [id],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Polling: fast while a webhook is expected, slow while unpaid (to catch
  // expiry), and stopped once the order reaches a final state.
  const latest = order?.payments.at(-1);
  const awaiting = awaitingSince !== null && order?.status === "PENDING_PAYMENT" && latest?.status === "requires_payment";
  useEffect(() => {
    if (!order) return;
    if (awaitingSince !== null && !awaiting) setAwaitingSince(null);
    const interval = awaiting ? 1000 : order.status === "PENDING_PAYMENT" ? 5000 : null;
    if (interval === null) return;
    const t = setTimeout(() => void load(), interval);
    return () => clearTimeout(t);
  }, [order, awaiting, awaitingSince, load]);

  // Tick once a second for the stock-hold countdown.
  useEffect(() => {
    if (!order?.canPay) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [order?.canPay]);

  // One idempotency key per payment attempt, derived from how many attempts
  // have already settled. Retrying the same attempt reuses the key, and a new
  // attempt after a decline gets a new one. No client storage needed.
  const startPayment = useCallback(async () => {
    if (!order || startingPayment) return;
    setStartingPayment(true);
    setPayError(null);
    const settled = order.payments.filter((p) => p.status !== "requires_payment").length;
    try {
      setSheet(await api.startPayment(order.id, `pay-${order.id}-${settled}`));
    } catch (err) {
      setPayError((err as Error).message);
      void load();
    } finally {
      setStartingPayment(false);
    }
  }, [order, startingPayment, load]);

  // Arriving from checkout with ?pay=1 opens the payment sheet once.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!order || autoOpened.current || params.get("pay") !== "1") return;
    autoOpened.current = true;
    setParams({}, { replace: true });
    if (order.canPay) void startPayment();
  }, [order, params, setParams, startPayment]);

  async function confirm(outcome: MockOutcome, duplicate: boolean) {
    await api.confirmMockPayment(sheet!.nextAction.url, outcome, duplicate);
    setSheet(null);
    setAwaitingSince(Date.now());
    void load();
  }

  if (loadError && !order) {
    return (
      <main className="wrap page">
        {loadError.status === 404 ? (
          <ErrorBlock title="Order not found" message="Check the link, or make sure you're signed in to the account that placed it." />
        ) : (
          <ErrorBlock title="We couldn't load this order" message={loadError.message} onRetry={() => void load()} />
        )}
      </main>
    );
  }
  if (!order) return <main className="wrap page"><LoadingBlock label="Loading your order…" /></main>;

  const copy = STATUS_COPY[order.status];
  const msLeft = new Date(order.reservationExpiresAt).getTime() - now;
  const slow = awaiting && awaitingSince !== null && now - awaitingSince > SLOW_CONFIRMATION_MS;
  const tone: Tone = awaiting ? "processing" : copy.tone;
  firstTone.current ??= tone;
  const changed = tone !== firstTone.current;

  return (
    <main className="wrap page order">
      <section className={`status status--${tone}`} aria-live="polite">
        <p className="eyebrow mono">Order {order.id}</p>
        {/* Keyed by tone so the entrance animation replays on every status change. */}
        <div key={tone} className={`status__head${changed ? ` status__head--enter-${tone}` : ""}`}>
          <StatusBadge tone={tone} />
          <h1 className="display display--sm">{awaiting ? "Confirming payment" : copy.title}</h1>
          {changed && tone === "paid" && <Confetti />}
        </div>
        <p className="status__lede">{describe(order, awaiting, slow)}</p>

        <Steps order={order} awaiting={awaiting} />

        {order.canPay && !awaiting && (
          <div className="status__actions">
            <button className="btn btn--accent btn--lg" onClick={() => void startPayment()} disabled={startingPayment || awaiting}>
              {startingPayment ? (
                <>
                  <Spinner label="Starting payment" /> Opening payment…
                </>
              ) : order.status === "PAYMENT_FAILED" ? (
                `Retry payment · ${formatMoney(order.total)}`
              ) : (
                `Pay ${formatMoney(order.total)}`
              )}
            </button>
            {msLeft > 0 && (
              <span className="hold">
                Items held for <strong className="mono">{formatCountdown(msLeft)}</strong>
              </span>
            )}
          </div>
        )}
        {payError && (
          <div className="banner banner--error" role="alert">
            {payError}
          </div>
        )}
        {!order.canPay && (
          <div className="status__actions">
            <Link to="/" className="btn btn--ghost">
              {order.status === "EXPIRED" ? "Start a new order" : "Continue shopping"}
            </Link>
          </div>
        )}
      </section>

      <div className="order__cols">
        <section aria-labelledby="items-h">
          <h2 id="items-h" className="h2">Items</h2>
          <ul className="receipt">
            {order.items.map((i) => (
              <li key={i.sku}>
                <span>
                  {i.name} <span className="muted">× {i.qty}</span>
                </span>
                <span>{formatMoney(i.lineTotal)}</span>
              </li>
            ))}
            <li className="receipt__total">
              <span>Total</span>
              <span>{formatMoney(order.total)}</span>
            </li>
          </ul>

          {order.payments.length > 0 && (
            <>
              <h2 className="h2">Payment attempts</h2>
              <ul className="attempts">
                {order.payments.map((p, n) => (
                  <li key={p.id}>
                    <span className="mono">#{n + 1} · {p.id}</span>
                    <span key={p.status} className={`pill pill--${p.status}`}>{p.status.replaceAll("_", " ")}</span>
                    {p.status === "amount_mismatch" && p.amountReceived !== null && (
                      <span className="muted">
                        received {formatMoney(p.amountReceived)} of {formatMoney(p.amount)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="timeline-h">
          <h2 id="timeline-h" className="h2">Timeline</h2>
          <ol className="timeline">
            {order.timeline.map((e, n) => (
              <li key={n} style={{ "--i": n } as CSSProperties}>
                <span className="mono muted">{formatTime(e.at)}</span>
                <span>
                  <strong>{STATUS_COPY[e.to].title}</strong>
                  {e.reason && <span className="muted"> · {humanize(e.reason)}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {sheet && (
        <MockPaySheet
          amount={sheet.paymentIntent.amount}
          intentId={sheet.paymentIntent.id}
          onConfirm={confirm}
          onClose={() => setSheet(null)}
        />
      )}
    </main>
  );
}

function describe(order: Order, awaiting: boolean, slow: boolean): string {
  if (awaiting) {
    return slow
      ? "This is taking longer than usual. Keep this page open: it updates as soon as the bank confirms, and you won't be charged twice."
      : "Payment submitted. We're waiting for the payment provider to confirm it, which usually takes a few seconds.";
  }
  switch (order.status) {
    case "PENDING_PAYMENT":
      return "Your items are reserved. Complete payment to confirm the order.";
    case "PAYMENT_FAILED":
      return `${humanize(order.statusReason)}. No money was taken. Your items are still held, so you can try again.`;
    case "PAID":
      return order.statusReason === "paid_after_expiry"
        ? "Payment arrived just after your hold expired, but the items were still in stock. You're all set."
        : "Payment received. We'll email you when it ships.";
    case "NEEDS_REVIEW":
      return order.statusReason === "amount_mismatch"
        ? "We received a different amount than your order total. Our team will contact you to finish the payment or refund it. Nothing ships until then."
        : "Your payment arrived after the items sold out. We'll refund you in full automatically.";
    case "EXPIRED":
      return "The 15-minute hold ran out before payment, so the items went back on sale.";
  }
}

function Steps({ order, awaiting }: { order: Order; awaiting: boolean }) {
  const paid = order.status === "PAID";
  const stuck = order.status === "PAYMENT_FAILED" || order.status === "EXPIRED" || order.status === "NEEDS_REVIEW";
  const steps = [
    { label: "Placed", state: "done" },
    { label: "Payment", state: paid ? "done" : stuck ? "bad" : awaiting ? "active" : "todo" },
    { label: "Confirmed", state: paid ? "done" : "todo" },
  ];
  return (
    <ol className="steps" aria-label="Order progress">
      {steps.map((s) => (
        <li key={s.label} className={`steps__item steps__item--${s.state}`}>
          {s.label}
        </li>
      ))}
    </ol>
  );
}
