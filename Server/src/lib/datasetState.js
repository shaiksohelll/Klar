import crypto from "node:crypto";
import DatasetState from "../models/DatasetState.js";

const DATASET_ID = "jobs";
const SOURCES = new Set(["adzuna", "jsearch"]);
const SUMMARY_FIELDS = [
  "requested",
  "fetched",
  "unique",
  "upserted",
  "modified",
  "removed",
  "pruneFailures",
  "errors",
  "totalInDb",
  "bulkWriteError",
];

function assertSource(source) {
  if (!SOURCES.has(source)) throw new Error(`Unknown dataset source: ${source}`);
}

// A run is considered active (still writing) while sources.<source>.status is
// "running" AND its lastAttemptAt is within this window. Anything older is
// presumed crashed (process killed, deploy restart, etc.) — the flag must not
// stay wedged forever, so a stale run is eligible for takeover.
//
// Live runs renew their claim via a heartbeat (see HEARTBEAT_INTERVAL_MS),
// so this window now guards CRASH RECOVERY only — takeover happens when
// heartbeats have stopped (dead process), never on a slow-but-alive run.
// 30 min is intentionally >> HEARTBEAT_INTERVAL_MS (5 min) so a single
// missed heartbeat doesn't trigger a false takeover.
export const STALE_RUN_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// How often a live run bumps lastAttemptAt to prove it's still alive.
// Must be << STALE_RUN_WINDOW_MS so the claim never expires while a
// healthy run is executing.
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function safeError(error) {
  return (error instanceof Error ? error.message : String(error ?? "Unknown error")).slice(0, 500);
}

function sanitizeSummary(result) {
  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    if (result?.[field] !== undefined) summary[field] = result[field];
  }
  return summary;
}

function classifyResult(result) {
  const requested = Number(result?.requested ?? 0);
  // Zero-request runs (e.g. JSearch's free-tier early-return when
  // JSEARCH_API_KEY is unset). A defensive no-op case for any source that
  // returns requested: 0. Nothing was fetched, so this must never read as
  // "succeeded" and advance version/asOf off a run that did nothing.
  if (requested === 0) return "skipped";
  const errors = Number(result?.errors ?? 0);
  // Total failure: every request errored out (and there was at least one
  // request to make). Nothing usable landed, so this must NOT be reported as
  // "partial" — a run with zero real progress should read as failed, not
  // advance version/asOf, and record lastFailureAt like the throw path does.
  if (requested > 0 && errors >= requested) return "failed";
  const hasProblems =
    errors > 0 ||
    Number(result?.pruneFailures ?? 0) > 0 ||
    Boolean(result?.bulkWriteError);
  return hasProblems ? "partial" : "succeeded";
}

/**
 * Begin a dataset run for `source`.
 *
 * Refuses (returns a skipped descriptor, does NOT touch runId/status/
 * runningSources) when that source already has an active run whose
 * lastAttemptAt is within STALE_RUN_WINDOW_MS — this is what prevents a
 * second concurrent run for the same source from hijacking runId out from
 * under the first. Without this guard, run B could overwrite run A's runId
 * and later settle (complete/fail) the source out of runningSources while
 * run A is still writing, making ingestionInProgress read false mid-write.
 *
 * A run whose lastAttemptAt is OLDER than the staleness window is presumed
 * crashed (killed process, deploy restart, etc.) and is eligible for
 * takeover — otherwise a crashed run would wedge the source in
 * runningSources (and ingestionInProgress=true) forever, since nothing is
 * left to call completeDatasetRun/failDatasetRun with the orphaned runId.
 */
async function beginDatasetRun(source) {
  assertSource(source);
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const prefix = `sources.${source}`;
  const staleThreshold = new Date(startedAt.getTime() - STALE_RUN_WINDOW_MS);

  // Ensure the singleton document exists first. Two concurrent first-ever
  // calls can both race this upsert and one may lose with a duplicate-key
  // error (fixed _id, no unique index tricks needed) — that's fine, it just
  // means the other call already created the doc, so swallow E11000 only.
  try {
    await DatasetState.updateOne(
      { _id: DATASET_ID },
      { $setOnInsert: { _id: DATASET_ID, version: 0 } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  const updated = await DatasetState.findOneAndUpdate(
    {
      _id: DATASET_ID,
      $or: [
        { [`${prefix}.status`]: { $ne: "running" } },
        { [`${prefix}.lastAttemptAt`]: null },
        { [`${prefix}.lastAttemptAt`]: { $lt: staleThreshold } },
      ],
    },
    {
      $addToSet: { runningSources: source },
      $set: {
        [`${prefix}.runId`]: runId,
        [`${prefix}.status`]: "running",
        [`${prefix}.lastAttemptAt`]: startedAt,
        [`${prefix}.lastError`]: null,
      },
    },
    { new: true },
  );

  if (!updated) {
    // Active, non-stale run already owns this source — refuse the takeover.
    return { source, runId: null, startedAt, skipped: true, reason: "overlap" };
  }

  return { source, runId, startedAt };
}

async function completeDatasetRun(run, result) {
  const completedAt = new Date();
  const status = classifyResult(result);
  const prefix = `sources.${run.source}`;
  const advancesDataset = status === "succeeded" || status === "partial";
  const set = {
    [`${prefix}.runId`]: null,
    [`${prefix}.status`]: status,
    [`${prefix}.lastCompletedAt`]: completedAt,
    [`${prefix}.lastSummary`]: sanitizeSummary(result),
    [`${prefix}.lastError`]: null,
  };
  if (status === "succeeded") set[`${prefix}.lastSuccessAt`] = completedAt;
  if (status === "partial") set[`${prefix}.lastPartialAt`] = completedAt;
  // A run that returned (didn't throw) but had every request fail is
  // classified "failed" — record lastFailureAt exactly like the throw path
  // (failDatasetRun) does, so downstream freshness reads treat it the same
  // way. version/asOf are NOT advanced (advancesDataset stays false).
  // lastError is also set here (generic, no provider detail) so the public
  // hasError flag — which is just Boolean(lastError) — reads true whenever
  // status is "failed", matching the throw path's behavior.
  if (status === "failed") {
    set[`${prefix}.lastFailureAt`] = completedAt;
    set[`${prefix}.lastError`] = "All source requests failed";
  }
  if (advancesDataset) set.asOf = completedAt;

  const update = { $set: set, $pull: { runningSources: run.source } };
  if (advancesDataset) update.$inc = { version: 1 };

  return DatasetState.findOneAndUpdate(
    { _id: DATASET_ID, [`${prefix}.runId`]: run.runId },
    update,
    { new: true },
  ).lean();
}

async function failDatasetRun(run, error) {
  const failedAt = new Date();
  const prefix = `sources.${run.source}`;
  return DatasetState.findOneAndUpdate(
    { _id: DATASET_ID, [`${prefix}.runId`]: run.runId },
    {
      $set: {
        [`${prefix}.runId`]: null,
        [`${prefix}.status`]: "failed",
        [`${prefix}.lastCompletedAt`]: failedAt,
        [`${prefix}.lastFailureAt`]: failedAt,
        [`${prefix}.lastError`]: safeError(error),
        [`${prefix}.lastSummary`]: null,
      },
      $pull: { runningSources: run.source },
    },
    { new: true },
  ).lean();
}

/**
 * APPROVED CONTRACT AMENDMENT (fail-closed on begin failure):
 * If beginDatasetRun itself throws (e.g. a DatasetState write/connectivity
 * error), the run is REFUSED — `work` is never invoked — rather than running
 * it untracked. An untracked run would write real Job data (and burn
 * provider quota) with no DatasetState record at all: no runningSources
 * entry, no way to later mark it failed/succeeded, and no overlap protection
 * for a second attempt. Refusing is strictly safer than silently ingesting
 * off the books.
 *
 * This is intentionally asymmetric with the completion/failure paths below:
 * once a run has legitimately started (beginDatasetRun succeeded), a
 * completeDatasetRun/failDatasetRun write failure stays fail-OPEN (logged,
 * swallowed, ingest result still returned, version does not advance) because
 * `work` has already run and its real-world side effects (Job writes,
 * provider calls) cannot be undone — dropping the result on top of that
 * would only destroy the one copy of evidence that the run happened.
 */
export async function trackDatasetRun(source, work) {
  let run;
  try {
    run = await beginDatasetRun(source);
  } catch (error) {
    console.warn(`dataset state begin failed [${source}]:`, safeError(error));
    return { skipped: true, reason: "begin-failed" };
  }

  if (run?.skipped) {
    // Another active (non-stale) run already owns this source — do not run
    // `work` at all. Running it anyway is the overlap this guard exists to
    // prevent (duplicate provider calls + concurrent writes to the same
    // source's Job rows).
    console.warn(`dataset run skipped [${source}]: an active run is already in progress`);
    return { skipped: true, reason: run.reason };
  }

  // ── Heartbeat: renew the claim while work() is executing ──────────────
  // Bumps lastAttemptAt every HEARTBEAT_INTERVAL_MS so a slow-but-alive run
  // never looks stale. Write failures are logged and swallowed (fail-open —
  // a heartbeat must never kill a healthy run). The timer is unref'd so it
  // can't keep a shutting-down process alive, and cleared in finally so it
  // can never outlive the run.
  const prefix = `sources.${source}`;
  const heartbeat = setInterval(async () => {
    try {
      await DatasetState.updateOne(
        { _id: DATASET_ID, [`${prefix}.runId`]: run.runId },
        { $set: { [`${prefix}.lastAttemptAt`]: new Date() } },
      );
    } catch (err) {
      console.warn(`heartbeat write failed [${source}]:`, safeError(err));
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    const result = await work();
    if (run) {
      try {
        await completeDatasetRun(run, result);
      } catch (error) {
        console.warn(`dataset state completion failed [${source}]:`, safeError(error));
      }
    }
    return result;
  } catch (error) {
    if (run) {
      try {
        await failDatasetRun(run, error);
      } catch (stateError) {
        console.warn(`dataset state failure write failed [${source}]:`, safeError(stateError));
      }
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

// ── Internal serializer (server + tests only) ──────────────────────────────
// Retains diagnostic fields (lastError, lastSummary). NEVER send this shape to
// a client — use getPublicDatasetMetadata() for anything that leaves the server.
function serializeSourceInternal(source = {}) {
  return {
    status: source.status ?? "idle",
    lastAttemptAt: source.lastAttemptAt?.toISOString?.() ?? null,
    lastCompletedAt: source.lastCompletedAt?.toISOString?.() ?? null,
    lastSuccessAt: source.lastSuccessAt?.toISOString?.() ?? null,
    lastPartialAt: source.lastPartialAt?.toISOString?.() ?? null,
    lastFailureAt: source.lastFailureAt?.toISOString?.() ?? null,
    lastError: source.lastError ?? null,
    lastSummary: source.lastSummary ?? null,
  };
}

export async function getDatasetMetadataInternal() {
  const state = await DatasetState.findById(DATASET_ID).lean();
  if (!state) {
    return {
      version: 0,
      asOf: null,
      ingestionInProgress: false,
      runningSources: [],
      sources: { adzuna: serializeSourceInternal(), jsearch: serializeSourceInternal() },
    };
  }

  const runningSources = Array.isArray(state.runningSources) ? state.runningSources : [];
  return {
    version: state.version ?? 0,
    asOf: state.asOf?.toISOString?.() ?? null,
    ingestionInProgress: runningSources.length > 0,
    runningSources,
    sources: {
      adzuna: serializeSourceInternal(state.sources?.adzuna),
      jsearch: serializeSourceInternal(state.sources?.jsearch),
    },
  };
}

// ── Public serializer (safe to return over the wire) ────────────────────────
// Drops runId, lastError, lastSummary and every other internal diagnostic.
// The only error signal exposed is a boolean `hasError` — never the message,
// stack, provider body, or Mongo/bulkWrite detail.
function serializeSourcePublic(source = {}) {
  return {
    status: source.status ?? "idle",
    lastAttemptAt: source.lastAttemptAt?.toISOString?.() ?? null,
    lastCompletedAt: source.lastCompletedAt?.toISOString?.() ?? null,
    lastSuccessAt: source.lastSuccessAt?.toISOString?.() ?? null,
    lastPartialAt: source.lastPartialAt?.toISOString?.() ?? null,
    lastFailureAt: source.lastFailureAt?.toISOString?.() ?? null,
    hasError: Boolean(source.lastError),
  };
}

// Honest empty/fallback public contract. Reused as the route's fail-safe when
// the DatasetState read throws, so a metadata outage can never break ranking.
export function emptyPublicDatasetMetadata() {
  return {
    version: 0,
    asOf: null,
    ingestionInProgress: false,
    runningSources: [],
    sources: { adzuna: serializeSourcePublic(), jsearch: serializeSourcePublic() },
  };
}

export async function getPublicDatasetMetadata() {
  const state = await DatasetState.findById(DATASET_ID).lean();
  if (!state) return emptyPublicDatasetMetadata();

  const runningSources = Array.isArray(state.runningSources) ? state.runningSources : [];
  return {
    version: state.version ?? 0,
    asOf: state.asOf?.toISOString?.() ?? null,
    ingestionInProgress: runningSources.length > 0,
    runningSources,
    sources: {
      adzuna: serializeSourcePublic(state.sources?.adzuna),
      jsearch: serializeSourcePublic(state.sources?.jsearch),
    },
  };
}

export const __datasetStateTestables = {
  classifyResult,
  sanitizeSummary,
  beginDatasetRun,
  completeDatasetRun,
  failDatasetRun,
};
