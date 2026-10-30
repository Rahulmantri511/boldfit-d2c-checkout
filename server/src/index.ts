import { createApp } from "./app.js";
import { loadConfig, systemClock } from "./config.js";
import { openDb, seedIfEmpty } from "./db.js";
import { MockPayProvider } from "./mockProvider/mockPay.js";
import { expireStaleOrders } from "./services/orders.js";

const config = loadConfig();
const db = openDb(config.dbPath);
seedIfEmpty(db);

const provider = new MockPayProvider({
  secret: config.webhookSecret,
  webhookUrl: config.webhookUrl,
  clock: systemClock,
  deliveryDelayMs: config.mockWebhookDelayMs,
});

const app = createApp({ db, config, clock: systemClock, provider });

// Background sweep. Reads and payment attempts also expire lazily, so this is just tidying up.
const sweeper = setInterval(() => {
  const n = expireStaleOrders(db, systemClock);
  if (n) console.log(`[sweeper] expired ${n} order(s), stock released`);
}, 15_000);

const server = app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(sweeper);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
