import { Link } from "react-router-dom";
import { useCart } from "../cart/cart";
import { ProductCard } from "../components/ProductCard";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../components/States";
import { formatMoney } from "../lib/format";
import { useProducts } from "../lib/useProducts";

export function CatalogPage() {
  const { state, retry } = useProducts();
  const { lines, count } = useCart();

  const subtotal =
    state.status === "ready"
      ? lines.reduce((sum, l) => sum + (state.products.find((p) => p.sku === l.sku)?.price ?? 0) * l.qty, 0)
      : 0;

  return (
    <main className="wrap page">
      <section className="intro">
        <p className="eyebrow">Shop · {state.status === "ready" ? `${state.products.length} products` : "Catalog"}</p>
        <h1 className="display">
          Train hard.
          <br />
          Check out fast.
        </h1>
      </section>

      {state.status === "loading" && <LoadingBlock label="Loading products…" />}
      {state.status === "error" && (
        <ErrorBlock title="We couldn't load the catalog" message={state.message} onRetry={retry} />
      )}
      {state.status === "ready" && state.products.length === 0 && (
        <EmptyBlock title="Nothing in stock right now">
          <p>New drops land every week. Check back soon.</p>
        </EmptyBlock>
      )}
      {state.status === "ready" && state.products.length > 0 && (
        <div className="grid">
          {state.products.map((p) => (
            <ProductCard key={p.sku} product={p} />
          ))}
        </div>
      )}

      {count > 0 && (
        <div className="checkout-bar" role="region" aria-label="Cart summary">
          <span>
            <strong>{count}</strong> item{count === 1 ? "" : "s"} · {formatMoney(subtotal)}
          </span>
          <Link to="/checkout" className="btn btn--accent">
            Checkout →
          </Link>
        </div>
      )}
    </main>
  );
}
