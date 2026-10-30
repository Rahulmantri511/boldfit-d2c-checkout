import type { Clock } from "../config.js";
import { ApiError } from "../errors.js";
import type { PaymentWebhookEvent } from "../dto.js";
import { newId } from "../services/orders.js";
import type { PaymentProvider } from "../services/payments.js";
import { signatureHeader, SIGNATURE_HEADER } from "../webhookSignature.js";

export type Outcome = "success" | "failure" | "partial";
export type Deliver = (url: string, rawBody: string, headers: Record<string, string>) => Promise<number>;

interface ProviderIntent {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  status: "requires_payment" | "processing";
}

const httpDeliver: Deliver = async (url, rawBody, headers) => {
  const res = await fetch(url, { method: "POST", body: rawBody, headers });
  return res.status;
};

/**
 * In-process stand-in for Razorpay/Stripe. It keeps its own state (like a
 * real third party would), honours idempotency keys on intent creation, and
 * delivers HMAC-signed webhooks over real HTTP with retry and backoff.
 */
export class MockPayProvider implements PaymentProvider {
  private intents = new Map<string, ProviderIntent>();
  private intentByIdemKey = new Map<string, string>();
  private sent = new Map<string, { rawBody: string; headers: Record<string, string> }>();
  private inFlight = new Set<Promise<void>>();

  constructor(
    private readonly opts: {
      secret: string;
      webhookUrl: string;
      clock: Clock;
      deliveryDelayMs: number;
      deliver?: Deliver;
      maxAttempts?: number;
    },
  ) {}

  async createIntent(input: { amount: number; currency: string; orderId: string }, idempotencyKey: string) {
    const knownId = this.intentByIdemKey.get(idempotencyKey);
    if (knownId) return this.intents.get(knownId)!;
    const intent: ProviderIntent = { id: newId("pi"), status: "requires_payment", ...input };
    this.intents.set(intent.id, intent);
    this.intentByIdemKey.set(idempotencyKey, intent.id);
    return intent;
  }

  /** What the shopper does on the provider's hosted payment page. */
  confirm(intentId: string, outcome: Outcome, duplicateDelivery = false) {
    const intent = this.intents.get(intentId);
    if (!intent) throw new ApiError(404, "not_found", "Payment intent not found");
    if (intent.status !== "requires_payment") {
      throw new ApiError(409, "intent_already_confirmed", "This payment was already submitted");
    }
    intent.status = "processing";

    const event: PaymentWebhookEvent = {
      id: newId("evt"),
      type: outcome === "failure" ? "payment.failed" : "payment.succeeded",
      created: Math.floor(this.opts.clock() / 1000),
      data: {
        paymentIntentId: intent.id,
        orderId: intent.orderId,
        amount: intent.amount,
        amountReceived: outcome === "success" ? intent.amount : outcome === "partial" ? Math.floor(intent.amount / 2) : 0,
        currency: intent.currency,
        ...(outcome === "failure" ? { failureReason: "card_declined" } : {}),
      },
    };
    const rawBody = JSON.stringify(event);
    const headers = {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signatureHeader(this.opts.secret, event.created, rawBody),
    };
    this.sent.set(event.id, { rawBody, headers });

    this.track(
      delay(this.opts.deliveryDelayMs).then(() =>
        Promise.all(
          Array.from({ length: duplicateDelivery ? 2 : 1 }, () => this.deliverWithRetry(event.id, rawBody, headers)),
        ).then(() => undefined),
      ),
    );
    return { id: intent.id, status: intent.status, eventId: event.id };
  }

  /**
   * Re-sends a past event byte-for-byte, original signature included, the way
   * an attacker or a confused proxy would. Within the tolerance window it is
   * deduped; after that the timestamp check rejects it.
   */
  replay(eventId: string) {
    const sent = this.sent.get(eventId);
    if (!sent) throw new ApiError(404, "not_found", "Event not found");
    this.track(this.deliverWithRetry(eventId, sent.rawBody, sent.headers));
    return { eventId, replayed: true };
  }

  /** Test helper: wait until every scheduled delivery has finished. */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  private track(p: Promise<void>) {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  /** Retries 5xx/429/network errors with exponential backoff; any other 4xx is final. */
  private async deliverWithRetry(eventId: string, rawBody: string, headers: Record<string, string>) {
    const deliver = this.opts.deliver ?? httpDeliver;
    const maxAttempts = this.opts.maxAttempts ?? 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const status = await deliver(this.opts.webhookUrl, rawBody, headers);
        console.log(`[mockpay] ${eventId} attempt ${attempt} -> ${status}`);
        if (status < 300) return;
        if (status < 500 && status !== 429) return;
      } catch (err) {
        console.warn(`[mockpay] ${eventId} attempt ${attempt} failed: ${(err as Error).message}`);
      }
      await delay(250 * 2 ** attempt);
    }
    console.error(`[mockpay] ${eventId} gave up after ${maxAttempts} attempts`);
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
