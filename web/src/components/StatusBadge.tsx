import type { CSSProperties } from "react";

export type Tone = "pending" | "processing" | "paid" | "failed" | "review" | "expired";

const ICONS: Partial<Record<Tone, string>> = {
  paid: "M7 12.5l3.2 3.2L17 9", // check
  failed: "M8 8l8 8M16 8l-8 8", // cross
  review: "M12 7v6M12 16.5v.5", // exclamation
  expired: "M12 7.5V12l3 2", // clock hands
};

/** Round icon next to the order status title. Purely decorative: the title says the same thing. */
export function StatusBadge({ tone }: { tone: Tone }) {
  if (tone === "pending") return null;
  return (
    <span className={`badge badge--${tone}`} aria-hidden="true">
      {tone === "processing" ? (
        <span className="spinner badge__spinner" />
      ) : (
        <svg viewBox="0 0 24 24" className="badge__icon">
          {tone === "expired" && <circle cx="12" cy="12" r="7" className="badge__stroke" />}
          <path d={ICONS[tone]} className="badge__stroke badge__draw" pathLength={1} />
        </svg>
      )}
      {tone === "paid" && <span className="badge__ring" />}
    </span>
  );
}

const CONFETTI_COLORS = ["var(--accent)", "var(--ink)", "var(--ok)", "#ff6b3d", "#3b4cca"];

// Fixed burst pattern so it looks the same every time (and in screenshots).
const PIECES = Array.from({ length: 22 }, (_, i) => {
  const angle = (i / 22) * Math.PI * 2 + (i % 2) * 0.2;
  const dist = 90 + ((i * 37) % 70);
  return {
    "--x": `${Math.round(Math.cos(angle) * dist)}px`,
    "--y": `${Math.round(Math.sin(angle) * dist * 0.75 - 30)}px`,
    "--r": `${(i * 47) % 360}deg`,
    "--c": CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    "--d": `${(i % 5) * 18}ms`,
  } as CSSProperties;
});

/** One-off burst played when an order flips to PAID while the shopper is watching. */
export function Confetti() {
  return (
    <span className="confetti" aria-hidden="true">
      {PIECES.map((style, i) => (
        <span key={i} className={`confetti__piece${i % 3 === 0 ? " confetti__piece--round" : ""}`} style={style} />
      ))}
    </span>
  );
}
