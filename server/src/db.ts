import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

// Money is stored as integer paise. Timestamps are epoch milliseconds.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  sku          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL,
  price_paise  INTEGER NOT NULL CHECK (price_paise > 0),
  stock        INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id                      TEXT PRIMARY KEY,
  customer_id             TEXT NOT NULL,
  status                  TEXT NOT NULL,
  status_reason           TEXT,
  total_paise             INTEGER NOT NULL,
  currency                TEXT NOT NULL,
  reservation_expires_at  INTEGER NOT NULL,
  stock_released          INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_expiry ON orders (status, reservation_expires_at);

CREATE TABLE IF NOT EXISTS order_items (
  order_id          TEXT NOT NULL REFERENCES orders (id),
  sku               TEXT NOT NULL REFERENCES products (sku),
  name              TEXT NOT NULL,
  unit_price_paise  INTEGER NOT NULL,
  qty               INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (order_id, sku)
);

-- Append-only audit trail of status changes; also powers the UI timeline.
CREATE TABLE IF NOT EXISTS order_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL REFERENCES orders (id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders (id),
  amount_paise    INTEGER NOT NULL,
  amount_received_paise INTEGER,
  status          TEXT NOT NULL,
  failure_reason  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
-- At most one payable intent per order: the DB backstop against double charging.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_intent_per_order
  ON payment_intents (order_id) WHERE status = 'requires_payment';

-- Every webhook event id we have processed. The primary key is the dedupe.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id           TEXT PRIMARY KEY,
  type               TEXT NOT NULL,
  payment_intent_id  TEXT,
  outcome            TEXT,
  received_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  customer_id    TEXT NOT NULL,
  idem_key       TEXT NOT NULL,
  endpoint       TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  status_code    INTEGER,          -- NULL while the request is in flight
  response_body  TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (customer_id, idem_key)
);
`;

export function openDb(path = ":memory:"): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/**
 * Runs fn inside a write transaction. node:sqlite is synchronous, so nothing
 * else can interleave between BEGIN and COMMIT inside this process; BEGIN
 * IMMEDIATE also takes the write lock up front against other processes.
 * Never await inside fn.
 */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const SEED_PRODUCTS = [
  {
    sku: "BF-WHEY-1KG",
    name: "Whey Protein · Double Rich Chocolate",
    description: "1 kg tub, 24 g protein per scoop. Mixes clean, no clumps.",
    category: "Nutrition",
    price_paise: 2_499_00,
    stock: 25,
  },
  {
    sku: "BF-YOGA-MAT",
    name: "Yoga Mat 6 mm Anti-Skid",
    description: "Dual-texture TPE with alignment lines and a carry strap.",
    category: "Training",
    price_paise: 799_00,
    stock: 40,
  },
  {
    sku: "BF-RES-BANDS",
    name: "Resistance Bands · Set of 5",
    description: "5 to 25 kg loop bands for warm-ups, mobility and rehab.",
    category: "Training",
    price_paise: 649_00,
    stock: 3,
  },
  {
    sku: "BF-SHAKER-700",
    name: "Gym Shaker Bottle 700 ml",
    description: "Leak-proof lid, steel mixing ball, BPA-free.",
    category: "Accessories",
    price_paise: 299_00,
    stock: 100,
  },
  {
    sku: "BF-GLOVES",
    name: "Gym Gloves with Wrist Support",
    description: "Padded palm and 18-inch wrist wrap for heavy pressing.",
    category: "Accessories",
    price_paise: 449_00,
    stock: 0,
  },
] as const;

export function seedIfEmpty(db: DB): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number };
  if (row.n > 0) return;
  const insert = db.prepare(
    "INSERT INTO products (sku, name, description, category, price_paise, stock) VALUES (?, ?, ?, ?, ?, ?)",
  );
  tx(db, () => {
    for (const p of SEED_PRODUCTS) {
      insert.run(p.sku, p.name, p.description, p.category, p.price_paise, p.stock);
    }
  });
}
