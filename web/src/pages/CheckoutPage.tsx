import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api/client";
import { MAX_QTY_PER_LINE, useCart } from "../cart/cart";
import { EmptyBlock, ErrorBlock, LoadingBlock, Spinner } from "../components/States";
import { formatMoney, newIdempotencyKey } from "../lib/format";
import { useProducts } from "../lib/useProducts";

type Shortage = { sku: string; requested: number; available: number };

export function CheckoutPage() {
  const { state, retry } = useProducts();
  const { lines, dispatch } = useCart();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [shortages, setShortages] = useState<Shortage[]>([]);

  // One idempotency key per cart revision. A retry after a timeout or a
  // double-click sends the same key, so the server creates one order. Editing
  // the cart makes a new key, because that's a different request.
  const keyRef = useRef<{ signature: string; key: string } | null>(null);
  const signature = JSON.stringify(lines);
  if (keyRef.current?.signature !== signature) {
    keyRef.current = { signature, key: newIdempotencyKey("order") };
  }

  if (state.status === "loading") return <main className="wrap page"><LoadingBlock label="Loading your cart…" /></main>;
  if (state.status === "error") {
    return (
      <main className="wrap page">
        <ErrorBlock title="We couldn't load your cart" message={state.message} onRetry={retry} />
      </main>
    );
  }

  const bySku = new Map(state.products.map((p) => [p.sku, p]));
  const rows = lines.map((l) => ({ ...l, product: bySku.get(l.sku) }));
  const subtotal = rows.reduce((s, r) => s + (r.product?.price ?? 0) * r.qty, 0);

  if (rows.length === 0) {
    return (
      <main className="wrap page">
        <h1 className="display display--sm">Your cart</h1>
        <EmptyBlock title="Your cart is empty">
          <p>Add a few things from the shop and come back here to check out.</p>
          <Link to="/" className="btn">Browse products</Link>
        </EmptyBlock>
      </main>
    );
  }

  async function placeOrder() {
    if (submitting) return; // the disabled button is the first guard; the idempotency key is the real one
    setSubmitting(true);
    setError(null);
    setShortages([]);
    try {
      const order = await api.createOrder(lines, keyRef.current!.key);
      dispatch({ type: "clear" });
      navigate(`/orders/${order.id}?pay=1`, { replace: true });
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, "unknown", (err as Error).message);
      setError(e);
      if (e.code === "insufficient_stock") {
        setShortages((e.details as { items: Shortage[] }).items);
        retry(); // refresh stock numbers
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="wrap page checkout">
      <section>
        <h1 className="display display--sm">Your cart</h1>
        <ul className="lines">
          {rows.map(({ sku, qty, product }) => {
            const short = shortages.find((s) => s.sku === sku);
            const max = Math.min(product?.stock ?? 0, MAX_QTY_PER_LINE);
            return (
              <li key={sku} className="line">
                <div className="line__info">
                  <p className="line__name">{product?.name ?? sku}</p>
                  <p className="line__sub mono">{sku}</p>
                  {!product && <p className="line__warn">This item is no longer sold. Remove it to continue.</p>}
                  {product && !product.inStock && <p className="line__warn">Sold out. Remove it to continue.</p>}
                  {short && (
                    <p className="line__warn">
                      Only {short.available} left. You asked for {short.requested}.
                    </p>
                  )}
                </div>
                <div className="stepper" aria-label={`Quantity for ${product?.name ?? sku}`}>
                  <button
                    aria-label="Decrease quantity"
                    onClick={() => dispatch({ type: "set", sku, qty: qty - 1, max: Math.max(max, qty) })}
                  >
                    −
                  </button>
                  <span aria-live="polite">{qty}</span>
                  <button
                    aria-label="Increase quantity"
                    disabled={qty >= max}
                    onClick={() => dispatch({ type: "set", sku, qty: qty + 1, max })}
                  >
                    +
                  </button>
                </div>
                <p className="line__total">{product ? formatMoney(product.price * qty) : "—"}</p>
                <button className="link" onClick={() => dispatch({ type: "remove", sku })}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <aside className="summary" aria-label="Order summary">
        <p className="eyebrow">Summary</p>
        <dl className="summary__rows">
          <div>
            <dt>Subtotal</dt>
            <dd>{formatMoney(subtotal)}</dd>
          </div>
          <div>
            <dt>Shipping</dt>
            <dd>Free</dd>
          </div>
          <div className="summary__total">
            <dt>Total</dt>
            <dd>{formatMoney(subtotal)}</dd>
          </div>
        </dl>
        <p className="fineprint">
          Prices are confirmed by the server when you place the order. Stock is held for 15 minutes while you pay.
        </p>

        {error && (
          <div className="banner banner--error" role="alert">
            <strong>{error.code === "insufficient_stock" ? "Some items just sold out." : "Couldn't place the order."}</strong>{" "}
            {error.code === "insufficient_stock" ? "Adjust the highlighted items and try again." : error.message}
            {error.retryable && " It's safe to try again; you won't be charged twice."}
          </div>
        )}

        <button className="btn btn--accent btn--block btn--lg" onClick={placeOrder} disabled={submitting}>
          {submitting ? (
            <>
              <Spinner label="Placing order" /> Placing order…
            </>
          ) : (
            `Place order & pay ${formatMoney(subtotal)}`
          )}
        </button>
        <Link to="/" className="link link--center">
          ← Keep shopping
        </Link>
      </aside>
    </main>
  );
}
