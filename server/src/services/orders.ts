import { randomUUID } from "node:crypto";
import type { Clock } from "../config.js";
import { tx, type DB } from "../db.js";
import { ApiError, notFound } from "../errors.js";
import {
  canTransition,
  PAYABLE,
  RESERVATION_HOLDING,
  type OrderStatus,
} from "../domain/orderStateMachine.js";
import type { CreateOrderRequest, OrderDTO, PaymentIntentDTO, ProductDTO } from "../dto.js";

export interface OrderRow {
  id: string;
  customer_id: string;
  status: OrderStatus;
  status_reason: string | null;
  total_paise: number;
  currency: "INR";
  reservation_expires_at: number;
  stock_released: number;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  sku: string;
  name: string;
  unit_price_paise: number;
  qty: number;
}

interface ProductRow {
  sku: string;
  name: string;
  description: string;
  category: string;
  price_paise: number;
  stock: number;
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;

export function listProducts(db: DB): ProductDTO[] {
  const rows = db.prepare("SELECT * FROM products ORDER BY rowid").all() as unknown as ProductRow[];
  return rows.map((p) => ({
    sku: p.sku,
    name: p.name,
    description: p.description,
    category: p.category,
    price: p.price_paise,
    currency: "INR",
    stock: p.stock,
    inStock: p.stock > 0,
  }));
}

/**
 * Creates an order and reserves stock atomically. Must run inside a
 * transaction (the idempotency commit provides one).
 *
 * Reserving stock uses a conditional decrement
 * (UPDATE … SET stock = stock - n WHERE stock >= n). The check and the write
 * happen in one statement, so two shoppers racing for the last unit can't
 * both win. The same holds on Postgres under READ COMMITTED. The CHECK
 * (stock >= 0) constraint is a second line of defence.
 *
 * Prices come from the DB and are snapshotted onto the order. The client
 * only sends SKU and quantity, never a price.
 */
export function createOrderInTx(
  db: DB,
  clock: Clock,
  reservationTtlMs: number,
  customerId: string,
  req: CreateOrderRequest,
): OrderDTO {
  // Duplicate SKU lines are merged instead of rejected: that's what a cart means.
  const wanted = new Map<string, number>();
  for (const { sku, qty } of req.items) wanted.set(sku, (wanted.get(sku) ?? 0) + qty);

  const getProduct = db.prepare("SELECT * FROM products WHERE sku = ?");
  const products = new Map<string, ProductRow>();
  const unknown: string[] = [];
  for (const sku of wanted.keys()) {
    const p = getProduct.get(sku) as ProductRow | undefined;
    if (p) products.set(sku, p);
    else unknown.push(sku);
  }
  if (unknown.length) {
    throw new ApiError(422, "unknown_sku", "Some items are not in the catalog", { skus: unknown });
  }

  const reserve = db.prepare("UPDATE products SET stock = stock - ? WHERE sku = ? AND stock >= ?");
  const shortages: { sku: string; requested: number; available: number }[] = [];
  for (const [sku, qty] of wanted) {
    if (reserve.run(qty, sku, qty).changes === 0) {
      const { stock } = getProduct.get(sku) as unknown as ProductRow;
      shortages.push({ sku, requested: qty, available: stock });
    }
  }
  // Throwing rolls back the reservations that did succeed.
  if (shortages.length) {
    throw new ApiError(409, "insufficient_stock", "Some items don't have enough stock", { items: shortages });
  }

  const now = clock();
  const id = newId("ord");
  let total = 0;
  for (const [sku, qty] of wanted) total += products.get(sku)!.price_paise * qty;

  db.prepare(
    `INSERT INTO orders (id, customer_id, status, total_paise, currency, reservation_expires_at, created_at, updated_at)
     VALUES (?, ?, 'PENDING_PAYMENT', ?, 'INR', ?, ?, ?)`,
  ).run(id, customerId, total, now + reservationTtlMs, now, now);

  const insertItem = db.prepare(
    "INSERT INTO order_items (order_id, sku, name, unit_price_paise, qty) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [sku, qty] of wanted) {
    const p = products.get(sku)!;
    insertItem.run(id, sku, p.name, p.price_paise, qty);
  }
  recordEvent(db, now, id, null, "PENDING_PAYMENT", "order_created");

  return getOrderView(db, id);
}

/** Loads an order the caller owns. Other customers' orders return 404, so we don't leak that they exist. */
export function getOwnedOrder(db: DB, customerId: string, orderId: string): OrderRow {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
  if (!order || order.customer_id !== customerId) throw notFound("Order");
  return order;
}

export function getOrderRow(db: DB, orderId: string): OrderRow | undefined {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
}

/**
 * Compare-and-set status change. The UPDATE checks the expected current
 * status, so if a webhook and the expiry sweeper race, only the first one
 * moves the order and the second fails loudly instead of overwriting it.
 */
export function transition(
  db: DB,
  clock: Clock,
  order: OrderRow,
  to: OrderStatus,
  reason: string,
): void {
  if (!canTransition(order.status, to)) {
    throw new ApiError(409, "invalid_order_transition", `Order cannot move from ${order.status} to ${to}`);
  }
  const now = clock();
  const changed = db
    .prepare("UPDATE orders SET status = ?, status_reason = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(to, reason, now, order.id, order.status).changes;
  if (changed !== 1) {
    throw new ApiError(409, "order_state_conflict", "Order changed concurrently; retry");
  }
  recordEvent(db, now, order.id, order.status, to, reason);
  order.status = to;
  order.status_reason = reason;
  order.updated_at = now;
}

function recordEvent(db: DB, at: number, orderId: string, from: OrderStatus | null, to: OrderStatus, reason: string) {
  db.prepare(
    "INSERT INTO order_events (order_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(orderId, from, to, reason, at);
}

/** Returns reserved units to stock. Safe to call more than once thanks to the stock_released flag. */
export function releaseStock(db: DB, order: OrderRow): void {
  const flipped = db
    .prepare("UPDATE orders SET stock_released = 1 WHERE id = ? AND stock_released = 0")
    .run(order.id).changes;
  if (flipped === 0) return;
  const items = db.prepare("SELECT sku, qty FROM order_items WHERE order_id = ?").all(order.id) as unknown as ItemRow[];
  const restock = db.prepare("UPDATE products SET stock = stock + ? WHERE sku = ?");
  for (const it of items) restock.run(it.qty, it.sku);
  order.stock_released = 1;
}

/**
 * Tries to reserve stock again for an order whose reservation was released
 * (it was paid after expiry). All or nothing, using a savepoint.
 */
export function reReserveStock(db: DB, order: OrderRow): boolean {
  if (!order.stock_released) return true;
  const items = db.prepare("SELECT sku, qty FROM order_items WHERE order_id = ?").all(order.id) as unknown as ItemRow[];
  const reserve = db.prepare("UPDATE products SET stock = stock - ? WHERE sku = ? AND stock >= ?");
  db.exec("SAVEPOINT rereserve");
  for (const it of items) {
    if (reserve.run(it.qty, it.sku, it.qty).changes === 0) {
      db.exec("ROLLBACK TO rereserve; RELEASE rereserve");
      return false;
    }
  }
  db.exec("RELEASE rereserve");
  db.prepare("UPDATE orders SET stock_released = 0 WHERE id = ?").run(order.id);
  order.stock_released = 0;
  return true;
}

/**
 * Moves unpaid orders whose reservation has lapsed to EXPIRED and puts their
 * stock back. Runs on a timer and right before order reads and payment
 * attempts, so correctness doesn't depend on the timer firing on time.
 */
export function expireStaleOrders(db: DB, clock: Clock, onlyOrderId?: string): number {
  return tx(db, () => {
    const now = clock();
    const placeholders = RESERVATION_HOLDING.map(() => "?").join(",");
    const stale = db
      .prepare(
        `SELECT * FROM orders WHERE status IN (${placeholders}) AND reservation_expires_at <= ?
         ${onlyOrderId ? "AND id = ?" : ""}`,
      )
      .all(...RESERVATION_HOLDING, now, ...(onlyOrderId ? [onlyOrderId] : [])) as unknown as OrderRow[];
    for (const order of stale) {
      transition(db, clock, order, "EXPIRED", "reservation_expired");
      releaseStock(db, order);
    }
    return stale.length;
  });
}

export function getOrderView(db: DB, orderId: string): OrderDTO {
  const o = getOrderRow(db, orderId);
  if (!o) throw notFound("Order");
  const items = db
    .prepare("SELECT sku, name, unit_price_paise, qty FROM order_items WHERE order_id = ? ORDER BY rowid")
    .all(orderId) as unknown as ItemRow[];
  const payments = db
    .prepare("SELECT * FROM payment_intents WHERE order_id = ? ORDER BY created_at, rowid")
    .all(orderId) as unknown as PaymentIntentRow[];
  const events = db
    .prepare("SELECT from_status, to_status, reason, created_at FROM order_events WHERE order_id = ? ORDER BY id")
    .all(orderId) as unknown as { from_status: OrderStatus | null; to_status: OrderStatus; reason: string | null; created_at: number }[];

  return {
    id: o.id,
    status: o.status,
    statusReason: o.status_reason,
    items: items.map((i) => ({
      sku: i.sku,
      name: i.name,
      unitPrice: i.unit_price_paise,
      qty: i.qty,
      lineTotal: i.unit_price_paise * i.qty,
    })),
    total: o.total_paise,
    currency: o.currency,
    reservationExpiresAt: new Date(o.reservation_expires_at).toISOString(),
    canPay: PAYABLE.includes(o.status),
    payments: payments.map(toPaymentIntentDTO),
    timeline: events.map((e) => ({
      from: e.from_status,
      to: e.to_status,
      reason: e.reason,
      at: new Date(e.created_at).toISOString(),
    })),
    createdAt: new Date(o.created_at).toISOString(),
    updatedAt: new Date(o.updated_at).toISOString(),
  };
}

export interface PaymentIntentRow {
  id: string;
  order_id: string;
  amount_paise: number;
  amount_received_paise: number | null;
  status: PaymentIntentDTO["status"];
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

export function toPaymentIntentDTO(p: PaymentIntentRow): PaymentIntentDTO {
  return {
    id: p.id,
    orderId: p.order_id,
    amount: p.amount_paise,
    amountReceived: p.amount_received_paise,
    currency: "INR",
    status: p.status,
    failureReason: p.failure_reason,
    createdAt: new Date(p.created_at).toISOString(),
  };
}
