import Job from "../models/Job.js";
import { extractSkills, normalizeRole } from "../lib/skills.js";

const APP_ID = process.env.ADZUNA_APP_ID;
const APP_KEY = process.env.ADZUNA_APP_KEY;

// Roles we sweep for full market breadth (used when no specific search term is given)
const ROLE_QUERIES = [
  "frontend developer",
  "backend developer",
  "full stack developer",
  "devops engineer",
  "data engineer",
  "mobile developer",
  "software developer",
];

// Fetch one page of results from Adzuna
// Wraps the request in a 10-second AbortController timeout so a stalled
// connection settles the Promise.allSettled entry (rejected) rather than
// hanging the entire ingest run indefinitely.
async function fetchPage({ country, page, what }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const url =
      `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}` +
      `?app_id=${APP_ID}&app_key=${APP_KEY}` +
      `&results_per_page=50&what=${encodeURIComponent(what)}&content-type=application/json`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Adzuna ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Map one Adzuna job into our Job schema shape
function mapJob(raw, country) {
  const title = raw.title || "";
  const description = raw.description || "";
  const min = raw.salary_min ?? null;
  const max = raw.salary_max ?? null;
  const midpoint =
    min != null && max != null ? (min + max) / 2 : (min ?? max ?? null);
  return {
    externalId: String(raw.id),
    source: "adzuna",
    title,
    normalizedRole: normalizeRole(title),
    companyName: raw.company?.display_name || "",
    isRemote: /remote/i.test(`${title} ${description}`),
    requiredSkills: extractSkills(`${title} ${description}`),
    salaryRange: {
      min,
      max,
      midpoint,
      currency: country === "in" ? "INR" : country === "us" ? "USD" : "GBP",
    },
    location: raw.location?.display_name || "",
    redirectUrl: raw.redirect_url || "",
    postedAt: raw.created ? new Date(raw.created) : new Date(),
  };
}

export async function ingestAdzuna({
  what,
  queries,
  country = "in",
  pages = 2,
  prune,
} = {}) {
  if (!APP_ID || !APP_KEY) {
    throw new Error("Missing ADZUNA_APP_ID or ADZUNA_APP_KEY in .env");
  }

  // What to search: explicit queries → single `what` → else all roles (breadth)
  const searchTerms = queries?.length ? queries : what ? [what] : ROLE_QUERIES;
  // Only prune stale jobs on a full sweep (not a narrow single-term query)
  const shouldPrune = prune ?? (!what && !queries?.length);

  const runStartedAt = new Date();
  let fetched = 0;
  const docsById = new Map(); // dedupe: same job can match multiple role queries

  // Build every (term, page) pair we need to fetch, then fire them all in
  // parallel with Promise.allSettled so a single Adzuna hiccup doesn't abort
  // the whole run — we just skip that batch and log the warning.
  const fetchJobs = searchTerms.flatMap((term) =>
    Array.from({ length: pages }, (_, i) => ({ term, page: i + 1 })),
  );

  const responses = await Promise.allSettled(
    fetchJobs.map(({ term, page }) => fetchPage({ country, page, what: term })),
  );

  let hadFailures = false;
  for (let i = 0; i < responses.length; i++) {
    if (responses[i].status === "rejected") {
      hadFailures = true;
      console.warn(
        `Adzuna fetch failed [term="${fetchJobs[i].term}" page=${fetchJobs[i].page}]:`,
        responses[i].reason?.message,
      );
      continue;
    }
    const results = responses[i].value?.results || [];
    fetched += results.length;
    for (const raw of results) {
      const doc = mapJob(raw, country);
      docsById.set(doc.externalId, doc);
    }
  }

  const ops = [...docsById.values()].map((doc) => ({
    updateOne: {
      filter: { source: doc.source, externalId: doc.externalId },
      update: { $set: doc },
      upsert: true,
    },
  }));

  let upserted = 0;
  let modified = 0;
  if (ops.length > 0) {
    const result = await Job.bulkWrite(ops, { ordered: false });
    upserted = result.upsertedCount || 0;
    modified = result.modifiedCount || 0;
  }

  let removed = 0;
  // Skip pruning whenever any fetch failed: we only saw a partial snapshot of
  // the current market, so jobs that weren't refreshed this run should not be
  // deleted — they may still be live, we just couldn't reach Adzuna for them.
  if (hadFailures && shouldPrune) {
    console.warn("prune skipped due to fetch failures");
  }
  if (shouldPrune && !hadFailures && fetched > 0) {
    const pruneResult = await Job.deleteMany({
      source: "adzuna",
      updatedAt: { $lt: runStartedAt },
    });
    removed = pruneResult.deletedCount || 0;
  }

  return {
    fetched,
    unique: docsById.size,
    upserted,
    modified,
    removed,
    totalInDb: await Job.countDocuments(),
  };
}
