import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";

/** The cart is just SKU -> qty. Prices always come from the server; the cart never stores them. */
export type CartState = Record<string, number>;

export type CartAction =
  | { type: "add"; sku: string; max: number }
  | { type: "set"; sku: string; qty: number; max: number }
  | { type: "remove"; sku: string }
  | { type: "clear" };

/** Matches the server's per-line limit, so the UI can't build a cart the API will reject. */
export const MAX_QTY_PER_LINE = 10;

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "add":
      return cartReducer(state, { type: "set", sku: action.sku, qty: (state[action.sku] ?? 0) + 1, max: action.max });
    case "set": {
      const cap = Math.min(action.max, MAX_QTY_PER_LINE);
      const qty = Math.max(0, Math.min(Math.floor(action.qty), cap));
      if (qty === 0) return cartReducer(state, { type: "remove", sku: action.sku });
      return { ...state, [action.sku]: qty };
    }
    case "remove": {
      const { [action.sku]: _removed, ...rest } = state;
      return rest;
    }
    case "clear":
      return {};
  }
}

const STORAGE_KEY = "boldfit.cart.v1";

function loadCart(): CartState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(
        Object.entries(parsed).filter(([, q]) => Number.isInteger(q) && (q as number) > 0),
      ) as CartState;
    }
  } catch {
    /* corrupted or unavailable storage: start empty */
  }
  return {};
}

interface CartContextValue {
  cart: CartState;
  dispatch: React.Dispatch<CartAction>;
  count: number;
  lines: { sku: string; qty: number }[];
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, dispatch] = useReducer(cartReducer, undefined, loadCart);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
    } catch {
      /* private mode etc. */
    }
  }, [cart]);

  const value = useMemo(() => {
    const lines = Object.entries(cart).map(([sku, qty]) => ({ sku, qty }));
    return { cart, dispatch, lines, count: lines.reduce((n, l) => n + l.qty, 0) };
  }, [cart]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}
