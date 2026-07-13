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
      fetched: 1,
      errors: 0,
      pruneFailures: 0,
      bulkWriteError: null,
    });
    expect(stale).toBeNull();
    await __datasetStateTestables.completeDatasetRun(second, {
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
      fetched: 1,
      errors: 0,
      pruneFailures: 0,
      bulkWriteError: null,
    });
    expect(orphanSettle).toBeNull();

    // The new run settles normally.
    await __datasetStateTestables.completeDatasetRun(takeover, {
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

  it("does not falsely settle ingestion when only one of two sources completes", async () => {
    const adzunaRun = await __datasetStateTestables.beginDatasetRun("adzuna");
    await __datasetStateTestables.beginDatasetRun("jsearch");
    await __datasetStateTestables.completeDatasetRun(adzunaRun, {
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
