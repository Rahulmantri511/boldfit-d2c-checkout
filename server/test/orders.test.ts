import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { BOB, makeHarness, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});

describe("catalog", () => {
  it("is public and reports stock", async () => {
    const res = await request(h.app).get("/products").expect(200);
    expect(res.body.products).toHaveLength(5);
    expect(res.body.products.find((p: { sku: string }) => p.sku === "BF-GLOVES")).toMatchObject({ inStock: false });
  });
});

describe("POST /orders", () => {
  it("requires a bearer token", async () => {
    const res = await request(h.app).post("/orders").send({ items: [{ sku: "BF-YOGA-MAT", qty: 1 }] });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("requires an Idempotency-Key", async () => {
    const res = await request(h.app)
      .post("/orders")
      .set("Authorization", "Bearer demo-token-alice")
      .send({ items: [{ sku: "BF-YOGA-MAT", qty: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("idempotency_key_required");
  });

  it.each([
    [{ items: [] }, "empty cart"],
    [{ items: [{ sku: "BF-YOGA-MAT", qty: 0 }] }, "zero qty"],
    [{ items: [{ sku: "BF-YOGA-MAT", qty: 1.5 }] }, "fractional qty"],
    [{ items: [{ sku: "BF-YOGA-MAT", qty: 1, price: 1 }] }, "client-supplied price"],
  ])("rejects %j (%s) with 400", async (body, _why) => {
    const res = await request(h.app)
      .post("/orders")
      .set("Authorization", "Bearer demo-token-alice")
      .set("Idempotency-Key", h.key())
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("prices from the server, merges duplicate lines and reserves stock", async () => {
    const res = await h.createOrder([
      { sku: "BF-YOGA-MAT", qty: 1 },
      { sku: "BF-SHAKER-700", qty: 2 },
      { sku: "BF-YOGA-MAT", qty: 1 },
    ]);
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/orders/${res.body.id}`);
    expect(res.body).toMatchObject({ status: "PENDING_PAYMENT", total: 2 * 799_00 + 2 * 299_00, canPay: true });
    expect(res.body.items).toHaveLength(2);
    expect(h.stockOf("BF-YOGA-MAT")).toBe(38);
    expect(h.stockOf("BF-SHAKER-700")).toBe(98);
  });

  it("replays the original response for a retried Idempotency-Key and reserves only once", async () => {
    const key = h.key();
    const first = await h.createOrder([{ sku: "BF-YOGA-MAT", qty: 1 }], key);
    const second = await h.createOrder([{ sku: "BF-YOGA-MAT", qty: 1 }], key);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body.id).toBe(first.body.id);
    expect(h.stockOf("BF-YOGA-MAT")).toBe(39);
  });

  it("dedupes a concurrent double-submit with the same key", async () => {
    const key = h.key();
    const results = await Promise.all([1, 2, 3].map(() => h.createOrder([{ sku: "BF-YOGA-MAT", qty: 1 }], key)));
    const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(h.stockOf("BF-YOGA-MAT")).toBe(39);
  });

  it("rejects reusing a key with a different body", async () => {
    const key = h.key();
    await h.createOrder([{ sku: "BF-YOGA-MAT", qty: 1 }], key);
    const res = await h.createOrder([{ sku: "BF-YOGA-MAT", qty: 2 }], key);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("idempotency_key_reused");
  });

  it("scopes keys per customer", async () => {
    const key = h.key();
    const a = await h.createOrder([{ sku: "BF-YOGA-MAT", qty: 1 }], key);
    const b = await h.createOrder([{ sku: "BF-YOGA-MAT", qty: 1 }], key, BOB);
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
  });

  it("returns 409 with per-item shortages and reserves nothing", async () => {
    const res = await h.createOrder([
      { sku: "BF-YOGA-MAT", qty: 1 },
      { sku: "BF-RES-BANDS", qty: 5 },
      { sku: "BF-GLOVES", qty: 1 },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("insufficient_stock");
    expect(res.body.error.details.items).toEqual([
      { sku: "BF-RES-BANDS", requested: 5, available: 3 },
      { sku: "BF-GLOVES", requested: 1, available: 0 },
    ]);
    expect(h.stockOf("BF-YOGA-MAT")).toBe(40); // rolled back
  });

  it("allows the failed key to be retried once stock is fixed", async () => {
    const key = h.key();
    expect((await h.createOrder([{ sku: "BF-RES-BANDS", qty: 5 }], key)).status).toBe(409);
    h.db.prepare("UPDATE products SET stock = 10 WHERE sku = 'BF-RES-BANDS'").run();
    expect((await h.createOrder([{ sku: "BF-RES-BANDS", qty: 5 }], key)).status).toBe(201);
  });

  it("returns 422 for unknown SKUs", async () => {
    const res = await h.createOrder([{ sku: "NOPE", qty: 1 }]);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: "unknown_sku", details: { skus: ["NOPE"] } });
  });

  it("never oversells the last units under concurrent checkouts", async () => {
    // BF-RES-BANDS has 3 units; 8 shoppers race for one each.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.createOrder([{ sku: "BF-RES-BANDS", qty: 1 }])),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    expect(h.stockOf("BF-RES-BANDS")).toBe(0);
  });
});

describe("GET /orders/:id", () => {
  it("hides other customers' orders behind a 404", async () => {
    const { body } = await h.createOrder([{ sku: "BF-YOGA-MAT", qty: 1 }]);
    expect((await h.getOrder(body.id)).status).toBe(200);
    expect((await h.getOrder(body.id, BOB)).status).toBe(404);
  });

  it("expires an unpaid order after the reservation TTL and releases stock exactly once", async () => {
    const { body } = await h.createOrder([{ sku: "BF-RES-BANDS", qty: 2 }]);
    expect(h.stockOf("BF-RES-BANDS")).toBe(1);

    h.advance(15 * 60_000 + 1);
    const res = await h.getOrder(body.id);
    expect(res.body).toMatchObject({ status: "EXPIRED", statusReason: "reservation_expired", canPay: false });
    expect(h.stockOf("BF-RES-BANDS")).toBe(3);

    await h.getOrder(body.id); // reading again must not release again
    expect(h.stockOf("BF-RES-BANDS")).toBe(3);
  });
});
