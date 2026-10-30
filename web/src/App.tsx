import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { CartProvider } from "./cart/cart";
import { Header } from "./components/Header";
import { EmptyBlock } from "./components/States";
import { CatalogPage } from "./pages/CatalogPage";
import { CheckoutPage } from "./pages/CheckoutPage";
import { OrderPage } from "./pages/OrderPage";

export function App() {
  return (
    <BrowserRouter>
      <CartProvider>
        <Header />
        <Routes>
          <Route path="/" element={<CatalogPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/orders/:id" element={<OrderPage />} />
          <Route
            path="*"
            element={
              <main className="wrap page">
                <EmptyBlock title="Page not found">
                  <Link to="/" className="btn">Back to shop</Link>
                </EmptyBlock>
              </main>
            }
          />
        </Routes>
      </CartProvider>
    </BrowserRouter>
  );
}
