import Job from "../models/Job.js";
import { extractSkills, normalizeRole } from "../lib/skills.js";
import { makeDedupeKey } from "../lib/dedupe.js";
import { clearTrendingCaches } from "../aggregations/trendingSkills.js";
import { clearPairsCache } from "../aggregations/skillPairs.js";
import { clearDetailCache } from "../routes/skillDetail.js";
import { clearCompaniesCache } from "../aggregations/topCompanies.js";

// JSearch (RapidAPI) — https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
//
// FREE-TIER SAFETY: if JSEARCH_API_KEY is absent the function logs a warning
// and returns early. The app boots and the Adzuna cron keeps running normally.
const JSEARCH_API_KEY = process.env.JSEARCH_API_KEY;
const JSEARCH_HOST = "jsearch.p.rapidapi.com";

// ── Role queries ────────────────────────────────────────────────────────────
// Mirrors the Adzuna ROLE_QUERIES list (same role taxonomy, same normalizeRole
// mapping). Capped at 6 to stay inside free-tier request budgets.
const JSEARCH_ROLE_QUERIES = [
  "frontend developer",
  "backend developer",
  "full stack developer",
  "devops engineer",
  "data engineer",
  "mobile developer",
];

// ── Per-request fetch with 10-second AbortController timeout ───────────────
// Mirrors adzuna's fetchPage: a stalled connection rejects the
// Promise.allSettled entry rather than hanging the whole run.
async function fetchPage({ query, page, numPages, datePosted }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const url = new URL(`https://${JSEARCH_HOST}/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("page", String(page));
    url.searchParams.set("num_pages", String(numPages));
    url.searchParams.set("date_posted", datePosted);

    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        "X-RapidAPI-Key": JSEARCH_API_KEY,
        "X-RapidAPI-Host": JSEARCH_HOST,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`JSearch ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Shape one JSearch item into our Job schema ──────────────────────────────
// Matches the salaryRange shape used by adzuna: { min, max, midpoint, currency }.
function mapJob(item, roleQuery) {
  const title = item.job_title || "";
  const description = item.job_description || "";
  const companyName = item.employer_name || "";

  const min = item.job_min_salary ?? null;
  const max = item.job_max_salary ?? null;
  const midpoint =
    min != null && max != null ? (min + max) / 2 : (min ?? max ?? null);
  const currency = item.job_salary_currency || null;

  const locationParts = [item.job_city, item.job_state, item.job_country].filter(
    Boolean,
  );

  return {
    externalId: `jsearch:${item.job_id}`,
    source: "jsearch",
    title,
    normalizedRole: normalizeRole(title) !== "other"
      ? normalizeRole(title)
      : normalizeRole(roleQuery), // fall back to the query role if title gives "other"
    companyName,
    isRemote: !!item.job_is_remote,
    requiredSkills: extractSkills(`${title} ${description}`),
    salaryRange:
      min != null || max != null || midpoint != null
        ? { min, max, midpoint, currency }
        : null,
    location: locationParts.join(", "),
    redirectUrl: item.job_apply_link || "",
    postedAt: item.job_posted_at_datetime_utc
      ? new Date(item.job_posted_at_datetime_utc)
      : new Date(),
    dedupeKey: makeDedupeKey(companyName, title),
  };
}

// ── Main export ─────────────────────────────────────────────────────────────
/**
 * Ingests jobs from JSearch (RapidAPI) into the shared Job collection.
 *
 * Mirrors ingestAdzuna's structure:
 *  - Promise.allSettled across all role queries (no single failure aborts the run)
 *  - 10-second AbortController timeout per request
 *  - Dedupe by externalId (`jsearch:<job_id>`) within this run
 *  - bulkWrite upsert — same filter strategy as Adzuna
 *  - Cache invalidation after a successful write
 *
 * @param {{ country?: string, pages?: number, datePosted?: string }} opts
 * @returns {Promise<{ requested: number, fetched: number, unique: number, upserted: number, modified: number }>}
 */
export async function ingestJSearch({
  country = "in",
  pages = 1,
  datePosted = "month",
} = {}) {
  // Free-tier safety: missing key → log + return early, never throw.
  if (!JSEARCH_API_KEY) {
    console.warn(
      "⚠️  JSEARCH_API_KEY is not set — JSearch ingest skipped. " +
        "Add it to .env to enable this source.",
    );
    return { requested: 0, fetched: 0, unique: 0, upserted: 0, modified: 0 };
  }

  // Build query strings: "frontend developer in in", "backend developer in in", …
  const queries = JSEARCH_ROLE_QUERIES.map((role) => ({
    role,
    query: `${role} in ${country}`,
  }));

  // ── Sequential fetch with inter-request delay ──────────────────────────
  // JSearch's free tier enforces a ~1 req/s rate limit. Parallel requests
  // trip the limiter (5-of-6 return 429). We fire queries one-by-one with a
  // 1.2s sleep between them. Per-query try/catch keeps error isolation: a
  // single 429 or timeout does not abort the remaining queries.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let fetched = 0;
  let errorCount = 0;
  let succeeded = 0;
  const docsById = new Map(); // dedupe within this run by externalId


  for (let i = 0; i < queries.length; i++) {
    const { role, query } = queries[i];
    // Delay BEFORE every request except the first.
    if (i > 0) await sleep(1_200);
    try {
      const json = await fetchPage({ query, page: 1, numPages: pages, datePosted });
      const items = json?.data || [];
      fetched += items.length;
      for (const item of items) {
        if (!item.job_id) continue;
        const doc = mapJob(item, role);
        docsById.set(doc.externalId, doc);
      }
      succeeded++;
    } catch (err) {
      errorCount++;
      console.warn(
        `JSearch fetch failed [role="${role}" query="${query}"]:`,
        err.message,
      );
    }
  }
  console.log(`JSearch fetch: ${succeeded}/${queries.length} queries succeeded, ${errorCount} failed`);


  // bulkWrite — same upsert strategy as Adzuna
  let upserted = 0;
  let modified = 0;
  if (docsById.size > 0) {
    const ops = [...docsById.values()].map((doc) => ({
      updateOne: {
        filter: { source: doc.source, externalId: doc.externalId },
        update: { $set: doc },
        upsert: true,
      },
    }));
    const result = await Job.bulkWrite(ops, { ordered: false });
    upserted = result.upsertedCount || 0;
    modified = result.modifiedCount || 0;
  }

  // ── Invalidate read caches ─────────────────────────────────────────────
  // Mirror exactly what ingestAdzuna does: clear all caches so the next
  // request recomputes from the freshly-written rows.
  clearTrendingCaches();
  clearPairsCache();
  clearDetailCache();
  clearCompaniesCache();

  const summary = {
    requested: queries.length,
    fetched,
    unique: docsById.size,
    upserted,
    modified,
    errors: errorCount,
  };
  console.log("🔄 JSearch ingest:", summary);
  return summary;
}
