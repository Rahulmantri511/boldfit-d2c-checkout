import type { ReactNode } from "react";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="state" aria-busy="true">
      <Spinner label={label} />
      <p>{label}</p>
    </div>
  );
}

export function ErrorBlock({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{title}</p>
      <p>{message}</p>
      {onRetry && (
        <button className="btn btn--ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyBlock({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state--empty">
      <p className="state__title">{title}</p>
      {children}
    </div>
  );
}
