/**
 * Removable chips for each active (non-default) facet filter.
 * Shows a "Clear all" link when two or more filters are active.
 */
export default function FacetChips({ chips, clearFilter, clearAll }) {
  if (!chips.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <button
          key={chip.key}
          onClick={() => clearFilter(chip.key)}
          aria-label={`Remove ${chip.label} filter`}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1 font-mono text-xs uppercase tracking-wider text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)]"
        >
          {chip.label}
          <span aria-hidden="true" className="text-[var(--muted-2)]">
            &times;
          </span>
        </button>
      ))}
      {chips.length >= 2 && (
        <button
          onClick={clearAll}
          className="font-mono text-[10px] uppercase tracking-widest text-[var(--muted-2)] transition-colors hover:text-[var(--accent)]"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
