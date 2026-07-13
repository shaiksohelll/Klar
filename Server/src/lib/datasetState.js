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

function classifyResult(source, result) {
  if (source === "jsearch" && Number(result?.requested ?? 0) === 0) return "skipped";
  const hasProblems =
    Number(result?.errors ?? 0) > 0 ||
    Number(result?.pruneFailures ?? 0) > 0 ||
    Boolean(result?.bulkWriteError);
  return hasProblems ? "partial" : "succeeded";
}

async function beginDatasetRun(source) {
  assertSource(source);
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const prefix = `sources.${source}`;

  await DatasetState.findOneAndUpdate(
    { _id: DATASET_ID },
    {
      $setOnInsert: { _id: DATASET_ID, version: 0 },
      $addToSet: { runningSources: source },
      $set: {
        [`${prefix}.runId`]: runId,
        [`${prefix}.status`]: "running",
        [`${prefix}.lastAttemptAt`]: startedAt,
        [`${prefix}.lastError`]: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { source, runId, startedAt };
}

async function completeDatasetRun(run, result) {
  const completedAt = new Date();
  const status = classifyResult(run.source, result);
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

export async function trackDatasetRun(source, work) {
  let run;
  try {
    run = await beginDatasetRun(source);
  } catch (error) {
    console.warn(`dataset state begin failed [${source}]:`, safeError(error));
  }

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
