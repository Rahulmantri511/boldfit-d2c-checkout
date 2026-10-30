export interface Config {
  port: number;
  dbPath: string;
  /** Shared secret the payment provider uses to HMAC-sign webhooks. */
  webhookSecret: string;
  /** Max clock skew (seconds) accepted on a webhook timestamp. Bounds the replay window. */
  webhookToleranceSec: number;
  /** How long stock stays reserved for an unpaid order. */
  reservationTtlMs: number;
  /** Hardcoded bearer tokens -> customer ids. Stand-in for a real auth system. */
  apiTokens: Record<string, string>;
  /** Where the mock provider delivers webhooks. */
  webhookUrl: string;
  /** Delay before the mock provider delivers a webhook, so the UI can show "processing". */
  mockWebhookDelayMs: number;
  mockProviderEnabled: boolean;
}

export const DEFAULT_TOKENS: Record<string, string> = {
  "demo-token-alice": "cus_alice",
  "demo-token-bob": "cus_bob",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 4000);
  return {
    port,
    dbPath: env.DB_PATH ?? "./data/checkout.db",
    webhookSecret: env.WEBHOOK_SECRET ?? "whsec_local_dev_only",
    webhookToleranceSec: Number(env.WEBHOOK_TOLERANCE_SEC ?? 300),
    reservationTtlMs: Number(env.RESERVATION_TTL_MS ?? 15 * 60_000),
    apiTokens: env.API_TOKENS ? JSON.parse(env.API_TOKENS) : DEFAULT_TOKENS,
    webhookUrl: env.WEBHOOK_URL ?? `http://localhost:${port}/webhooks/payment`,
    mockWebhookDelayMs: Number(env.MOCK_WEBHOOK_DELAY_MS ?? 1500),
    mockProviderEnabled: env.MOCK_PROVIDER_ENABLED !== "false",
  };
}

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
