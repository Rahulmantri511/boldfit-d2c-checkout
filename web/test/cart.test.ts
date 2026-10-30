import { describe, expect, it } from "vitest";
import { cartReducer, MAX_QTY_PER_LINE } from "../src/cart/cart";

describe("cartReducer", () => {
  it("adds and increments", () => {
    let s = cartReducer({}, { type: "add", sku: "A", max: 5 });
    s = cartReducer(s, { type: "add", sku: "A", max: 5 });
    expect(s).toEqual({ A: 2 });
  });

  it("never exceeds available stock or the per-line cap", () => {
    expect(cartReducer({ A: 3 }, { type: "add", sku: "A", max: 3 })).toEqual({ A: 3 });
    expect(cartReducer({}, { type: "set", sku: "A", qty: 99, max: 500 })).toEqual({ A: MAX_QTY_PER_LINE });
  });

  it("removes a line when qty drops to zero", () => {
    expect(cartReducer({ A: 1, B: 2 }, { type: "set", sku: "A", qty: 0, max: 5 })).toEqual({ B: 2 });
  });

  it("clears", () => {
    expect(cartReducer({ A: 1 }, { type: "clear" })).toEqual({});
  });
});
