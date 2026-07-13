import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import DatasetState from "./DatasetState.js";
import {
  __datasetStateTestables,
  getDatasetMetadataInternal,
  getPublicDatasetMetadata,
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

  it("prevents a stale run from overwriting a newer run", async () => {
    const first = await __datasetStateTestables.beginDatasetRun("adzuna");
    const second = await __datasetStateTestables.beginDatasetRun("adzuna");
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
