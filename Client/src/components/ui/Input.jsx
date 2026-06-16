import { forwardRef, useId } from "react";

// Input — always labelled, always h44, with an inline error slot that sits
// above-adjacent to the field (never color-only: an alert role + text). The
// label is visible by design; Klar never asks for the same thing twice, so
// callers prefill value from session state.
const Input = forwardRef(function Input(
  {
    label,
    hint,
    error,
    id,
    className = "",
    containerClassName = "",
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const inputId = id || autoId;
  const hintId = `${inputId}-hint`;
  const errId = `${inputId}-err`;

  return (
    <div className={["flex flex-col gap-1.5", containerClassName].join(" ")}>
      {label && (
        <label
          htmlFor={inputId}
          className="font-sans text-sm font-medium text-[var(--text)]"
        >
          {label}
        </label>
      )}
      {error && (
        <p
          id={errId}
          role="alert"
          className="text-sm text-[var(--neg)] font-medium"
        >
          {error}
        </p>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={[error ? errId : null, hint ? hintId : null]
          .filter(Boolean)
          .join(" ") || undefined}
        className={[
          "h-11 w-full px-3 rounded-[var(--radius-md)]",
          "bg-[var(--panel)] text-[var(--text)]",
          "border",
          error ? "border-[var(--neg)]" : "border-[var(--border)]",
          "placeholder:text-[var(--muted)]",
          "transition-[border-color,box-shadow] duration-[120ms]",
          "focus:outline-none focus:shadow-[var(--glow-red)] focus:border-[var(--accent)]",
          className,
        ].join(" ")}
        {...rest}
      />
      {hint && !error && (
        <p id={hintId} className="text-xs text-[var(--muted)]">
          {hint}
        </p>
      )}
    </div>
  );
});

export default Input;
