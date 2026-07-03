import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Job from "../models/Job.js";
import SkillSnapshot from "../models/SkillSnapshot.js";
import { recordSkillMomentumSnapshot, dayBucket } from "../ingest/snapshot.js";
import { makeDedupeKey } from "./dedupe.js";
import { ensureSkillSnapshotIndexes } from "./skillSnapshotIndexes.js";

// ── In-memory Mongo lifecycle ────────────────────────────────────────
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // autoIndex OFF — these tests fully own index state via beforeEach
  // dropIndexes + per-test createIndex/ensureSkillSnapshotIndexes. Without
  // this, Mongoose builds the schema's partial capturedAt_1 TTL async on
  // connect, and on a slow CI runner that build can land AFTER dropIndexes
  // but BEFORE the test's createIndex → IndexKeySpecsConflict (code 86).
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Job.deleteMany({});
  await SkillSnapshot.deleteMany({});
  // Start every test from a clean index slate so we control the starting state.
  try {
    await SkillSnapshot.collection.dropIndexes();
  } catch {
    // No indexes / fresh collection — fine.
  }
});

function jobDoc(overrides = {}) {
  const companyName = overrides.companyName ?? `Co-${Math.random().toString(36).slice(2)}`;
  const title = overrides.title ?? "Backend Developer";
  const location = overrides.location ?? "Bangalore";
  return {
    externalId: overrides.externalId ?? `adzuna:${Math.random()}`,
    source: "adzuna",
    title,
    normalizedRole: "backend",
    companyName,
    isRemote: false,
    requiredSkills: overrides.requiredSkills ?? ["node.js"],
    salaryRange: null,
    salaryDisclosed: false,
    location,
    redirectUrl: "",
    postedAt: new Date(),
    dedupeKey: makeDedupeKey(companyName, title, location),
  };
}

describe("SkillSnapshot capturedAt discipline", () => {
  it("a day-bucketed momentum row has NO capturedAt after upsert", async () => {
    await Job.create([jobDoc({ requiredSkills: ["node.js"] })]);
    const res = await recordSkillMomentumSnapshot();
    expect(res.ok).toBe(true);

    const row = await SkillSnapshot.findOne({ skill: "node.js", date: dayBucket() }).lean();
    expect(row).toBeTruthy();
    expect(row.date).toBeInstanceOf(Date);
    // The whole point: momentum rows must not carry a capturedAt (no default).
    expect(row.capturedAt).toBeUndefined();
  });

  it("a legacy velocity row still HAS an explicit capturedAt", async () => {
    // Mirrors how ingest/adzuna.js writes velocity rows: capturedAt set inline.
    const capturedAt = new Date();
    await SkillSnapshot.create({ skill: "node.js", count: 10, count30: 3, capturedAt });

    const row = await SkillSnapshot.findOne({ skill: "node.js", count: 10 }).lean();
    expect(row.capturedAt).toBeInstanceOf(Date);
    // Legacy rows carry no `date` (they are not day-bucketed momentum rows).
    expect(row.date).toBeUndefined();
  });
});

describe("ensureSkillSnapshotIndexes — migration", () => {
  // Extract the single-key capturedAt TTL indexes from a collection.indexes()
  // result for assertions.
  const capturedAtTtls = (indexes) =>
    indexes.filter((idx) => {
      const keys = Object.keys(idx.key || {});
      return keys.length === 1 && keys[0] === "capturedAt" && typeof idx.expireAfterSeconds === "number";
    });

  it("drops a legacy non-partial capturedAt_1 TTL and leaves exactly one partial TTL", async () => {
    // Simulate the deployed prod state: an OLD non-partial capturedAt TTL index.
    await SkillSnapshot.collection.createIndex(
      { capturedAt: 1 },
      { name: "capturedAt_1", expireAfterSeconds: 60 * 60 * 24 * 90 },
    );
    let before = capturedAtTtls(await SkillSnapshot.collection.indexes());
    expect(before).toHaveLength(1);
    expect(before[0].partialFilterExpression).toBeUndefined();

    const res = await ensureSkillSnapshotIndexes();
    expect(res.ok).toBe(true);
    expect(res.dropped).toContain("capturedAt_1");

    // End state: exactly ONE capturedAt TTL index, and it is partial.
    const after = capturedAtTtls(await SkillSnapshot.collection.indexes());
    expect(after).toHaveLength(1);
    expect(after[0].partialFilterExpression).toBeTruthy();
    // The partial filter scopes the TTL to legacy rows only. MongoDB forbids
    // $exists:false in partial indexes, so we key on capturedAt PRESENCE
    // (momentum rows carry no capturedAt and are therefore excluded).
    expect(after[0].partialFilterExpression).toMatchObject({ capturedAt: { $exists: true } });
  });

  it("is idempotent: a second run keeps exactly one partial capturedAt TTL", async () => {
    await ensureSkillSnapshotIndexes();
    const first = capturedAtTtls(await SkillSnapshot.collection.indexes());
    expect(first).toHaveLength(1);
    expect(first[0].partialFilterExpression).toBeTruthy();

    const res = await ensureSkillSnapshotIndexes();
    expect(res.ok).toBe(true);
    const second = capturedAtTtls(await SkillSnapshot.collection.indexes());
    expect(second).toHaveLength(1);
    expect(second[0].partialFilterExpression).toBeTruthy();
  });

  it("creates the partial TTL from scratch on a fresh collection (nothing to drop)", async () => {
    const res = await ensureSkillSnapshotIndexes();
    expect(res.ok).toBe(true);
    expect(res.dropped).toEqual([]);

    const after = capturedAtTtls(await SkillSnapshot.collection.indexes());
    expect(after).toHaveLength(1);
    expect(after[0].partialFilterExpression).toBeTruthy();
  });

  // Extract single-key `date` indexes and their sort direction.
  const dateIndexes = (indexes) =>
    indexes.filter((idx) => {
      const keys = Object.keys(idx.key || {});
      return keys.length === 1 && keys[0] === "date";
    });

  it("drops an obsolete descending { date: -1 } index and keeps the ascending TTL", async () => {
    // Simulate a deployed DB that still holds the OLD descending date index.
    await SkillSnapshot.collection.createIndex({ date: -1 }, { name: "date_-1" });
    const before = dateIndexes(await SkillSnapshot.collection.indexes());
    expect(before.some((i) => i.key.date === -1)).toBe(true);

    const res = await ensureSkillSnapshotIndexes();
    expect(res.ok).toBe(true);
    expect(res.dropped).toContain("date_-1");

    // End state: no descending date index; exactly one ascending { date: 1 }
    // TTL/range index remains.
    const after = dateIndexes(await SkillSnapshot.collection.indexes());
    expect(after.some((i) => i.key.date === -1)).toBe(false);
    const asc = after.filter((i) => i.key.date === 1);
    expect(asc).toHaveLength(1);
    expect(asc[0].expireAfterSeconds).toBe(60 * 60 * 24 * 400);
  });
});
