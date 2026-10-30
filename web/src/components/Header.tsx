import { Link } from "react-router-dom";
import { useCart } from "../cart/cart";

export function Header() {
  const { count } = useCart();
  return (
    <header className="header">
      <div className="wrap header__inner">
        <Link to="/" className="wordmark" aria-label="Boldfit home">
          BOLDFIT
        </Link>
        <span className="header__note">Demo store · mock payments</span>
        <Link to="/checkout" className="cart-pill" aria-label={`Cart, ${count} item${count === 1 ? "" : "s"}`}>
          Cart <span key={count} className="cart-pill__count">{count}</span>
        </Link>
      </div>
    </header>
  );
}
