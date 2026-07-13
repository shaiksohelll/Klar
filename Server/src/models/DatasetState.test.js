import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import DatasetState from "./DatasetState.js";
import {
  __datasetStateTestables,
  getDatasetMetadataInternal,
  getPublicDatasetMetadata,
  STALE_RUN_WINDOW_MS,
  trackDatasetRun,
} from "../lib/datasetState.js";

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await DatasetState.deleteMany({});
});

describe("DatasetState", () => {
  it("returns an honest empty contract before the first ingest", async () => {
    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(0);
    expect(meta.asOf).toBeNull();
    expect(meta.ingestionInProgress).toBe(false);
    expect(meta.sources.adzuna.status).toBe("idle");
    expect(meta.sources.jsearch.status).toBe("idle");
  });

  it("records success and advances the version", async () => {
    await trackDatasetRun("adzuna", async () => ({
      requested: 7,
      fetched: 12,
      unique: 10,
      upserted: 3,
      modified: 7,
      removed: 1,
      pruneFailures: 0,
      errors: 0,
      bulkWriteError: null,
    }));
    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(1);
    expect(meta.asOf).not.toBeNull();
    expect(meta.sources.adzuna.status).toBe("succeeded");
    expect(meta.sources.adzuna.lastSummary).toMatchObject({ fetched: 12, removed: 1 });
  });

  it("records partial evidence and advances the version", async () => {
    await trackDatasetRun("jsearch", async () => ({
      requested: 6,
      fetched: 5,
      unique: 5,
      upserted: 1,
      modified: 4,
      removed: 0,
      pruneFailures: 0,
      errors: 1,
      bulkWriteError: null,
    }));
    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(1);
    expect(meta.sources.jsearch.status).toBe("partial");
    expect(meta.sources.jsearch.lastPartialAt).not.toBeNull();
  });

  it("does not advance the version when JSearch is skipped", async () => {
    await trackDatasetRun("jsearch", async () => ({
      requested: 0,
      fetched: 0,
      unique: 0,
      upserted: 0,
      modified: 0,
      removed: 0,
      pruneFailures: 0,
      errors: 0,
      bulkWriteError: null,
    }));
    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(0);
    expect(meta.asOf).toBeNull();
    expect(meta.sources.jsearch.status).toBe("skipped");
  });

  // Fix F1: classifyResult previously special-cased jsearch for the
  // requested:0 -> "skipped" check. A zero-request Adzuna run fell through
  // to the hasProblems check (errors:0, pruneFailures:0, no bulkWriteError —
  // all false) and was misclassified "succeeded", which WOULD have advanced
  // version/asOf off a run that fetched nothing. Now requested === 0 ->
  // "skipped" for every source, and "skipped" never advances (advancesDataset
  // only true for "succeeded"/"partial" — that part of the contract was
  // already correct, only the classification was source-specific and wrong).
  it("does not advance the version when Adzuna makes a zero-request run (same as JSearch)", async () => {
    await trackDatasetRun("adzuna", async () => ({
      requested: 0,
      fetched: 0,
      unique: 0,
      upserted: 0,
      modified: 0,
      removed: 0,
      pruneFailures: 0,
      errors: 0,
      bulkWriteError: null,
    }));
    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(0);
    expect(meta.asOf).toBeNull();
    expect(meta.sources.adzuna.status).toBe("skipped");
    expect(meta.sources.adzuna.lastSuccessAt).toBeNull();
  });

  it("still advances the version for a normal (non-zero-request) run of either source", async () => {
    await trackDatasetRun("adzuna", async () => ({
      requested: 4,
      fetched: 4,
      unique: 4,
      upserted: 4,
      modified: 0,
      removed: 0,
      pruneFailures: 0,
      errors: 0,
      bulkWriteError: null,
    }));
    let meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(1);
    expect(meta.asOf).not.toBeNull();
    expect(meta.sources.adzuna.status).toBe("succeeded");

    await trackDatasetRun("jsearch", async () => ({
      requested: 6,
      fetched: 6,
      unique: 6,
      upserted: 6,
      modified: 0,
      removed: 0,
      pruneFailures: 0,
      errors: 0,
      bulkWriteError: null,
    }));
    meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(2);
    expect(meta.sources.jsearch.status).toBe("succeeded");
  });

  it("records failure without advancing and rethrows", async () => {
    await expect(
      trackDatasetRun("adzuna", async () => {
        throw new Error("upstream unavailable");
      }),
    ).rejects.toThrow("upstream unavailable");
    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(0);
    expect(meta.sources.adzuna.status).toBe("failed");
    expect(meta.sources.adzuna.lastError).toBe("upstream unavailable");
  });

  it("prevents an orphaned run's completion from overwriting a newer takeover run", async () => {
    // Two live runIds for the same source can only coexist today via the
    // staleness takeover path (a plain second begin is now refused outright
    // — see the overlap-refusal tests below). Simulate a crashed first run,
    // let a second run take over, then confirm the orphaned first run's
    // completion can't clobber the second run's state (runId mismatch).
    const first = await __datasetStateTestables.beginDatasetRun("adzuna");
    await DatasetState.updateOne(
      { _id: "jobs" },
      { $set: { "sources.adzuna.lastAttemptAt": new Date(Date.now() - STALE_RUN_WINDOW_MS - 1000) } },
    );
    const second = await __datasetStateTestables.beginDatasetRun("adzuna");
    expect(second.skipped).toBeUndefined();

    const stale = await __datasetStateTestables.completeDatasetRun(first, {
      requested: 1,
      fetched: 1,
      errors: 0,
      pruneFailures: 0,
      bulkWriteError: null,
    });
    expect(stale).toBeNull();
    await __datasetStateTestables.completeDatasetRun(second, {
      requested: 1,
      fetched: 2,
      errors: 0,
      pruneFailures: 0,
      bulkWriteError: null,
    });
    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(1);
    expect(meta.sources.adzuna.lastSummary.fetched).toBe(2);
  });

  it("public serializer strips internal error detail but keeps hasError", async () => {
    await expect(
      trackDatasetRun("adzuna", async () => {
        throw new Error("provider 500: secret-leaking body");
      }),
    ).rejects.toThrow();

    // Internal reader still carries the raw diagnostic for server/test use.
    const internal = await getDatasetMetadataInternal();
    expect(internal.sources.adzuna.lastError).toBe("provider 500: secret-leaking body");

    // Public reader exposes only a safe boolean — no message/summary/runId.
    const pub = await getPublicDatasetMetadata();
    expect(pub.sources.adzuna.hasError).toBe(true);
    expect(pub.sources.adzuna).not.toHaveProperty("lastError");
    expect(pub.sources.adzuna).not.toHaveProperty("lastSummary");
    expect(pub.sources.adzuna).not.toHaveProperty("runId");
    // Serialized JSON must not contain the raw message anywhere.
    expect(JSON.stringify(pub)).not.toContain("secret-leaking body");
  });

  it("reports ingestionInProgress while at least one source is still active", async () => {
    await __datasetStateTestables.beginDatasetRun("adzuna");
    await __datasetStateTestables.beginDatasetRun("jsearch");
    const both = await getPublicDatasetMetadata();
    expect(both.ingestionInProgress).toBe(true);
    expect(both.runningSources.sort()).toEqual(["adzuna", "jsearch"]);
  });

  it("refuses a second begin for the same source while a run is active", async () => {
    const first = await __datasetStateTestables.beginDatasetRun("adzuna");
    expect(first.skipped).toBeUndefined();
    expect(first.runId).not.toBeNull();

    const second = await __datasetStateTestables.beginDatasetRun("adzuna");
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("overlap");
    expect(second.runId).toBeNull();

    // The refused begin must not have advanced version or touched runId/state.
    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(0);
    expect(meta.runningSources).toEqual(["adzuna"]);
    expect(meta.sources.adzuna.status).toBe("running");

    // The original run can still complete normally afterwards.
    await __datasetStateTestables.completeDatasetRun(first, {
      requested: 4,
      fetched: 4,
      errors: 0,
      pruneFailures: 0,
      bulkWriteError: null,
    });
    const after = await getDatasetMetadataInternal();
    expect(after.version).toBe(1);
    expect(after.runningSources).toEqual([]);
    expect(after.sources.adzuna.status).toBe("succeeded");
  });

  it("does not run the work callback at all when trackDatasetRun is refused for overlap", async () => {
    await __datasetStateTestables.beginDatasetRun("jsearch");
    const work = vi.fn().mockResolvedValue({ fetched: 1, errors: 0, pruneFailures: 0, bulkWriteError: null });
    const result = await trackDatasetRun("jsearch", work);
    expect(work).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, reason: "overlap" });
  });

  // AMENDED CONTRACT (approved): if beginDatasetRun itself throws (write/
  // connectivity failure), trackDatasetRun now REFUSES the run — fail-closed
  // — instead of running `work` untracked. Previously this path swallowed the
  // begin error and ran `work` anyway (fail-open), which is what made an
  // untracked ingest possible: real Job writes + provider quota burned with
  // no DatasetState record at all. There was no prior test pinning that
  // fail-open behavior; this test is the first to cover the begin-failure
  // path and it encodes the NEW fail-closed contract.
  it("refuses the run (fail-closed) and never calls work() when beginDatasetRun itself throws", async () => {
    const findOneAndUpdateSpy = vi
      .spyOn(DatasetState, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("mongo blip"));
    const work = vi.fn().mockResolvedValue({ fetched: 1, errors: 0, pruneFailures: 0, bulkWriteError: null });

    const result = await trackDatasetRun("adzuna", work);

    expect(work).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, reason: "begin-failed" });

    findOneAndUpdateSpy.mockRestore();
    // The singleton upsert (DatasetState.updateOne) may still have created/
    // initialized the doc — that part isn't mocked. What matters, and what
    // the assertions below prove, is that the run CLAIM never landed: no
    // version bump, no runningSources entry, source still "idle".
    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(0);
    expect(meta.runningSources).toEqual([]);
    expect(meta.sources.adzuna.status).toBe("idle");
  });

  // Contrast case: once a run has legitimately STARTED, a completion-path
  // write failure stays fail-OPEN — `work` has already run (real side
  // effects happened), so the ingest result is still returned and only the
  // DatasetState write is logged/swallowed. Version must not advance since
  // the write that would have advanced it is exactly what failed.
  it("stays fail-open (returns the result) when the COMPLETION write fails after work() already ran", async () => {
    // beginDatasetRun's own findOneAndUpdate (call #1) must succeed so the
    // run legitimately starts; only completeDatasetRun's findOneAndUpdate
    // (call #2, keyed on runId) fails. Pass call #1 through to the real
    // implementation and reject only call #2.
    const original = DatasetState.findOneAndUpdate.bind(DatasetState);
    let callCount = 0;
    const findOneAndUpdateSpy = vi
      .spyOn(DatasetState, "findOneAndUpdate")
      .mockImplementation((...args) => {
        callCount++;
        if (callCount === 2) return Promise.reject(new Error("mongo blip mid-run"));
        return original(...args);
      });

    const work = vi.fn().mockResolvedValue({
      requested: 5,
      fetched: 5,
      errors: 0,
      pruneFailures: 0,
      bulkWriteError: null,
    });
    const result = await trackDatasetRun("adzuna", work);

    findOneAndUpdateSpy.mockRestore();
    expect(work).toHaveBeenCalledTimes(1);
    // Ingest result is returned intact despite the state-write failure.
    expect(result).toMatchObject({ fetched: 5 });

    // Version did not advance — the write that would have advanced it is
    // exactly the one that failed. The source is left "running"/wedged in
    // runningSources (matches existing fail-open posture: logged, not fixed
    // up), demonstrating why staleness takeover (Fix from the prior review)
    // still matters for this failure mode.
    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(0);
  });

  it("allows takeover of a stale run whose lastAttemptAt exceeds the staleness window", async () => {
    const stale = await __datasetStateTestables.beginDatasetRun("adzuna");
    // Simulate a crashed run: back-date lastAttemptAt past the staleness window
    // directly in storage (no fake timers — this is a real Mongo write).
    const longAgo = new Date(Date.now() - STALE_RUN_WINDOW_MS - 1000);
    await DatasetState.updateOne(
      { _id: "jobs" },
      { $set: { "sources.adzuna.lastAttemptAt": longAgo } },
    );

    const takeover = await __datasetStateTestables.beginDatasetRun("adzuna");
    expect(takeover.skipped).toBeUndefined();
    expect(takeover.runId).not.toBeNull();
    expect(takeover.runId).not.toBe(stale.runId);

    // runningSources still has exactly one "adzuna" entry (addToSet, no dupes).
    const meta = await getDatasetMetadataInternal();
    expect(meta.runningSources).toEqual(["adzuna"]);
    expect(meta.sources.adzuna.status).toBe("running");

    // The orphaned stale run can no longer settle anything (runId mismatch).
    const orphanSettle = await __datasetStateTestables.completeDatasetRun(stale, {
      requested: 1,
      fetched: 1,
      errors: 0,
      pruneFailures: 0,
      bulkWriteError: null,
    });
    expect(orphanSettle).toBeNull();

    // The new run settles normally.
    await __datasetStateTestables.completeDatasetRun(takeover, {
      requested: 9,
      fetched: 9,
      errors: 0,
      pruneFailures: 0,
      bulkWriteError: null,
    });
    const after = await getDatasetMetadataInternal();
    expect(after.version).toBe(1);
    expect(after.sources.adzuna.lastSummary.fetched).toBe(9);
    expect(after.runningSources).toEqual([]);
  });

  it("classifies an all-requests-failed run as failed and advances nothing", async () => {
    const result = await trackDatasetRun("adzuna", async () => ({
      requested: 5,
      fetched: 0,
      unique: 0,
      upserted: 0,
      modified: 0,
      removed: 0,
      pruneFailures: 0,
      errors: 5,
      bulkWriteError: null,
    }));
    // trackDatasetRun does not throw for this case — the work callback
    // resolved (it just reported total failure in its own return shape).
    expect(result).toMatchObject({ errors: 5, requested: 5 });

    const meta = await getDatasetMetadataInternal();
    expect(meta.version).toBe(0);
    expect(meta.asOf).toBeNull();
    expect(meta.sources.adzuna.status).toBe("failed");
    expect(meta.sources.adzuna.lastFailureAt).not.toBeNull();
    expect(meta.sources.adzuna.lastSuccessAt).toBeNull();
    expect(meta.sources.adzuna.lastPartialAt).toBeNull();
    expect(meta.runningSources).toEqual([]);
  });

  it("sets a generic public-safe lastError on an all-failed run so hasError reads true, then clears it on the next success", async () => {
    await trackDatasetRun("adzuna", async () => ({
      requested: 5,
      fetched: 0,
      unique: 0,
      upserted: 0,
      modified: 0,
      removed: 0,
      pruneFailures: 0,
      errors: 5,
      bulkWriteError: null,
    }));

    // Internal reader: generic message only, no provider/request detail leaked.
    const internal = await getDatasetMetadataInternal();
    expect(internal.sources.adzuna.status).toBe("failed");
    expect(internal.sources.adzuna.lastError).toBe("All source requests failed");

    // Public reader: hasError must be true whenever status is "failed" — same
    // invariant the throw path (failDatasetRun) already upholds.
    const pub = await getPublicDatasetMetadata();
    expect(pub.sources.adzuna.status).toBe("failed");
    expect(pub.sources.adzuna.hasError).toBe(true);
    expect(pub.sources.adzuna).not.toHaveProperty("lastError");

    // A subsequent successful run clears lastError (existing $set null on
    // every completeDatasetRun call) and hasError flips back to false.
    await trackDatasetRun("adzuna", async () => ({
      requested: 5,
      fetched: 5,
      unique: 5,
      upserted: 5,
      modified: 0,
      removed: 0,
      pruneFailures: 0,
      errors: 0,
      bulkWriteError: null,
    }));
    const pubAfter = await getPublicDatasetMetadata();
    expect(pubAfter.sources.adzuna.status).toBe("succeeded");
    expect(pubAfter.sources.adzuna.hasError).toBe(false);

    // Internal reader too: lastError itself (not just the derived hasError
    // flag) must be cleared back to null by the successful run's $set.
    const internalAfter = await getDatasetMetadataInternal();
    expect(internalAfter.sources.adzuna.lastError).toBeNull();
  });

  it("still classifies a mixed success/error run as partial (not failed)", async () => {
    await trackDatasetRun("adzuna", async () => ({
      requested: 5,
      fetched: 3,
      unique: 3,
      upserted: 3,
      modified: 0,
      removed: 0,
      pruneFailures: 0,
      errors: 2,
      bulkWriteError: null,
    }));
    const meta = await getDatasetMetadataInternal();
    // errors (2) < requested (5) — some requests succeeded, so this is a
    // partial run, not a total failure. Version DOES advance for partial.
    expect(meta.version).toBe(1);
    expect(meta.asOf).not.toBeNull();
    expect(meta.sources.adzuna.status).toBe("partial");
    expect(meta.sources.adzuna.lastPartialAt).not.toBeNull();
    expect(meta.sources.adzuna.lastFailureAt).toBeNull();
  });

  it("does not falsely settle ingestion when only one of two sources completes", async () => {
    const adzunaRun = await __datasetStateTestables.beginDatasetRun("adzuna");
    await __datasetStateTestables.beginDatasetRun("jsearch");
    await __datasetStateTestables.completeDatasetRun(adzunaRun, {
      requested: 3,
      fetched: 3,
      errors: 0,
      pruneFailures: 0,
      bulkWriteError: null,
    });
    const meta = await getPublicDatasetMetadata();
    expect(meta.ingestionInProgress).toBe(true);
    expect(meta.runningSources).toEqual(["jsearch"]);
    expect(meta.sources.adzuna.status).toBe("succeeded");
    expect(meta.sources.jsearch.status).toBe("running");
  });
});
