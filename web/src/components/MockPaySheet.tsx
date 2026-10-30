import { useEffect, useRef, useState } from "react";
import type { MockOutcome } from "../api/types";
import { formatMoney } from "../lib/format";
import { Spinner } from "./States";

interface Props {
  amount: number;
  intentId: string;
  onConfirm: (outcome: MockOutcome, duplicateDelivery: boolean) => Promise<void>;
  onClose: () => void;
}

const OUTCOMES: { outcome: MockOutcome; label: string; hint: string }[] = [
  { outcome: "success", label: "Pay successfully", hint: "Provider captures the full amount" },
  { outcome: "failure", label: "Decline the card", hint: "payment.failed → you can retry" },
  { outcome: "partial", label: "Partial capture", hint: "Only half arrives → order held for review" },
];

/**
 * Stands in for the provider's hosted checkout (Razorpay's modal, Stripe's
 * Payment Element). It's styled to look like someone else's UI on purpose.
 * Our app never sees card details; it only learns the result from the signed
 * webhook.
 */
export function MockPaySheet({ amount, intentId, onConfirm, onClose }: Props) {
  const [pending, setPending] = useState<MockOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal?.();
  }, []);

  async function choose(outcome: MockOutcome) {
    setPending(outcome);
    setError(null);
    try {
      await onConfirm(outcome, duplicate);
    } catch (err) {
      setError((err as Error).message);
      setPending(null);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="mockpay"
      aria-labelledby="mockpay-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
    >
      <div className="mockpay__head">
        <span className="mockpay__brand" id="mockpay-title">
          MockPay
        </span>
        <span className="mockpay__test">TEST MODE</span>
      </div>
      <p className="mockpay__amount">{formatMoney(amount)}</p>
      <p className="mockpay__ref mono">{intentId}</p>

      <div className="mockpay__options">
        {OUTCOMES.map((o) => (
          <button key={o.outcome} className="mockpay__option" disabled={pending !== null} onClick={() => choose(o.outcome)}>
            <span>
              {o.label}
              <small>{o.hint}</small>
            </span>
            {pending === o.outcome && <Spinner label="Submitting" />}
          </button>
        ))}
      </div>

      <label className="mockpay__toggle">
        <input type="checkbox" checked={duplicate} onChange={(e) => setDuplicate(e.target.checked)} disabled={pending !== null} />
        Send the webhook twice at once (tests dedupe)
      </label>

      {error && (
        <p className="mockpay__error" role="alert">
          {error}
        </p>
      )}

      <button className="link link--center" onClick={onClose} disabled={pending !== null}>
        Cancel. I'll pay later
      </button>
    </dialog>
  );
}
