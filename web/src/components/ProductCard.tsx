import type { Product } from "../api/types";
import { MAX_QTY_PER_LINE, useCart } from "../cart/cart";
import { formatMoney } from "../lib/format";

// Each SKU gets a colour tile with a short display word, standing in for product photos.
const TILE: Record<string, { word: string; tone: string }> = {
  "BF-WHEY-1KG": { word: "WHEY", tone: "tile--choc" },
  "BF-YOGA-MAT": { word: "MAT", tone: "tile--teal" },
  "BF-RES-BANDS": { word: "BANDS", tone: "tile--red" },
  "BF-SHAKER-700": { word: "SHAKE", tone: "tile--blue" },
  "BF-GLOVES": { word: "GRIP", tone: "tile--stone" },
};

export function ProductCard({ product }: { product: Product }) {
  const { cart, dispatch } = useCart();
  const inCart = cart[product.sku] ?? 0;
  const tile = TILE[product.sku] ?? { word: product.name.split(" ")[0]!.toUpperCase(), tone: "tile--stone" };
  const maxAddable = Math.min(product.stock, MAX_QTY_PER_LINE);
  const atLimit = inCart >= maxAddable;
  const lowStock = product.inStock && product.stock <= 5;

  return (
    <article className="product">
      <div className={`tile ${tile.tone} ${product.inStock ? "" : "tile--soldout"}`} aria-hidden="true">
        <span className="tile__word">{tile.word}</span>
      </div>
      <div className="product__meta">
        {!product.inStock ? (
          <span className="tag tag--muted">Sold out</span>
        ) : lowStock ? (
          <span className="tag">Only {product.stock} left</span>
        ) : (
          <span className="tag tag--outline">{product.category}</span>
        )}
        <span className="product__price">{formatMoney(product.price)}</span>
      </div>
      <h3 className="product__name">{product.name}</h3>
      <p className="product__desc">{product.description}</p>
      <button
        className="btn btn--block"
        disabled={!product.inStock || atLimit}
        onClick={() => dispatch({ type: "add", sku: product.sku, max: product.stock })}
      >
        {!product.inStock ? "Sold out" : atLimit ? "Max in cart" : inCart ? `Add another · ${inCart} in cart` : "Add to cart"}
      </button>
    </article>
  );
}
