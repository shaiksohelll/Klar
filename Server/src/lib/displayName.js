/**
 * Formats a raw canonical skill key for human-facing display, server-side.
 *
 * This mirrors Client/src/lib/displayName.js so a skill label rendered inside a
 * PRE-BAKED reasons[] badge matches exactly what the client shows for the row
 * title (which runs the client displayName over the same canonical key). The
 * client renders reasons[] verbatim, so any label baked into a reason string
 * must already be display-formatted here.
 *
 * The underlying canonical skill key (used for routing / API calls / scoring)
 * is NEVER mutated. Keep KNOWN_NAMES in sync with the client copy.
 */

const KNOWN_NAMES = {
  html: "HTML",
  css: "CSS",
  aws: "AWS",
  gcp: "GCP",
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
  const lower = String(raw).toLowerCase();
  if (KNOWN_NAMES[lower]) return KNOWN_NAMES[lower];
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
