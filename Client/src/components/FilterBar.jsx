import { motion } from "framer-motion";
import { ROLES, WINDOWS } from "../hooks/useFacetFilters";

// Sliding pill spring — stiffness 180, damping 22 (matches existing UI spring)
const pillSpring = { type: "spring", stiffness: 180, damping: 22 };

const REMOTE_OPTIONS = [
  { value: null, label: "Any" },
  { value: "remote", label: "Remote" },
  { value: "onsite", label: "On-site" },
];

/**
 * Shared role / window / remote / disclosed filter bar.
 *
 * @param {object}   props
 * @param {object}   props.filters      - Current filter values from useFacetFilters.
 * @param {Function} props.setFilter    - Setter from useFacetFilters (or wrapper).
 * @param {string}   [props.layoutPrefix] - Unique string to scope Framer layoutIds.
 */
export default function FilterBar({ filters, setFilter, layoutPrefix = "" }) {
  const { role, window: win, remote, disclosed } = filters;

  return (
    <section className="flex flex-col md:flex-row items-center justify-between gap-6 border-b border-[var(--border)] pb-6">
      {/* Role segmented control — sliding accent pill */}
      <div className="flex flex-wrap justify-center gap-2">
        {ROLES.map((r) => (
          <button
            key={r}
            onClick={() => setFilter("role", r)}
            aria-pressed={role === r}
            className={`relative px-4 py-2 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
              role === r
                ? "text-white"
                : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {role === r && (
              <motion.div
                layoutId={`${layoutPrefix}activeRole`}
                className="absolute inset-0 bg-[var(--accent)] rounded-full -z-10"
                transition={pillSpring}
              />
            )}
            {r}
          </button>
        ))}
      </div>

      {/* Right-side controls */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Window segmented control */}
        <div className="flex bg-[var(--panel)] border border-[var(--border)] rounded-full p-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setFilter("window", w)}
              aria-pressed={win === w}
              className={`relative px-4 py-1.5 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
                win === w
                  ? "text-white"
                  : "text-[var(--muted-2)] hover:text-[var(--muted)]"
              }`}
            >
              {win === w && (
                <motion.div
                  layoutId={`${layoutPrefix}activeWindow`}
                  className="absolute inset-0 bg-[var(--accent)] rounded-full -z-10"
                  transition={pillSpring}
                />
              )}
              {w}
            </button>
          ))}
        </div>

        {/* Work type (remote / on-site / any) */}
        <div className="flex bg-[var(--panel)] border border-[var(--border)] rounded-full p-1">
          {REMOTE_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => setFilter("remote", opt.value)}
              aria-pressed={remote === opt.value}
              className={`relative px-3 py-1.5 rounded-full font-mono text-xs uppercase tracking-wider transition-colors ${
                remote === opt.value
                  ? "text-white"
                  : "text-[var(--muted-2)] hover:text-[var(--muted)]"
              }`}
            >
              {remote === opt.value && (
                <motion.div
                  layoutId={`${layoutPrefix}activeRemote`}
                  className="absolute inset-0 bg-[var(--accent)] rounded-full -z-10"
                  transition={pillSpring}
                />
              )}
              {opt.label}
            </button>
          ))}
        </div>

        {/* Salary-disclosed toggle */}
        <button
          onClick={() => setFilter("disclosed", disclosed ? null : true)}
          aria-pressed={disclosed}
          className={`px-3 py-1.5 rounded-full font-mono text-xs uppercase tracking-wider border transition-colors ${
            disclosed
              ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
              : "border-[var(--border)] text-[var(--muted-2)] hover:text-[var(--muted)] hover:border-[var(--muted-2)]"
          }`}
        >
          Salary disclosed
        </button>
      </div>
    </section>
  );
}
