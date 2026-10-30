import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { Product } from "../api/types";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; products: Product[] };

export function useProducts() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    api
      .listProducts(ctrl.signal)
      .then((products) => setState({ status: "ready", products }))
      .catch((err: Error) => {
        if (err.name !== "AbortError") setState({ status: "error", message: err.message });
      });
    return () => ctrl.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
