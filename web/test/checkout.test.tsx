import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CartProvider } from "../src/cart/cart";
import { CheckoutPage } from "../src/pages/CheckoutPage";

const products = [
  { sku: "BF-YOGA-MAT", name: "Yoga Mat", description: "", category: "Training", price: 79900, currency: "INR", stock: 40, inStock: true },
];

function renderCheckout() {
  localStorage.setItem("boldfit.cart.v1", JSON.stringify({ "BF-YOGA-MAT": 2 }));
  return render(
    <MemoryRouter initialEntries={["/checkout"]}>
      <CartProvider>
        <Routes>
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/orders/:id" element={<p>order page</p>} />
        </Routes>
      </CartProvider>
    </MemoryRouter>,
  );
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let orderCalls: { key: string | null }[];

beforeEach(() => {
  orderCalls = [];
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("CheckoutPage", () => {
  it("shows the empty state when the cart is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { products })));
    render(
      <MemoryRouter>
        <CartProvider>
          <CheckoutPage />
        </CartProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Your cart is empty")).toBeInTheDocument();
  });

  it("reuses the same Idempotency-Key when retrying after a network failure", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/products")) return json(200, { products });
        orderCalls.push({ key: new Headers(init?.headers).get("Idempotency-Key") });
        if (fail) {
          fail = false;
          throw new TypeError("Failed to fetch");
        }
        return json(201, { id: "ord_1" });
      }),
    );
    renderCheckout();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /place order/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/safe to try again/i);

    await user.click(screen.getByRole("button", { name: /place order/i }));
    expect(await screen.findByText("order page")).toBeInTheDocument();

    expect(orderCalls).toHaveLength(2);
    expect(orderCalls[0]!.key).toMatch(/^order-/);
    expect(orderCalls[1]!.key).toBe(orderCalls[0]!.key);
  });

  it("disables the button while submitting so a double-click sends one request", async () => {
    let release!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/products")) return json(200, { products });
        orderCalls.push({ key: new Headers(init?.headers).get("Idempotency-Key") });
        await new Promise<void>((r) => (release = r));
        return json(201, { id: "ord_1" });
      }),
    );
    renderCheckout();
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: /place order/i });
    await user.dblClick(button);
    expect(button).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByText("order page")).toBeInTheDocument());
    expect(orderCalls).toHaveLength(1);
  });

  it("highlights the line that ran out of stock", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/products")) return json(200, { products });
        return json(409, {
          error: {
            code: "insufficient_stock",
            message: "",
            details: { items: [{ sku: "BF-YOGA-MAT", requested: 2, available: 1 }] },
          },
        });
      }),
    );
    renderCheckout();
    await userEvent.setup().click(await screen.findByRole("button", { name: /place order/i }));
    expect(await screen.findByText(/only 1 left/i)).toBeInTheDocument();
  });
});
