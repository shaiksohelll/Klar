/**
 * Formats a raw skill key for display.
 * Capitalises known acronyms correctly; for everything else, upper-cases
 * the first character and leaves the rest untouched.
 *
 * This is the single source of truth — import from here, never define locally.
 * The underlying skill key (used for routing / API calls) is NEVER mutated.
 */

const KNOWN_NAMES = {
  html: "HTML",
  css: "CSS",
  aws: "AWS",
  "ci/cd": "CI/CD",
  sql: "SQL",
  api: "API",
  typescript: "TypeScript",
  javascript: "JavaScript",
  node: "Node.js",
  nodejs: "Node.js",
  "node.js": "Node.js",
  php: "PHP",
};

export function displayName(raw) {
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (KNOWN_NAMES[lower]) return KNOWN_NAMES[lower];
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
