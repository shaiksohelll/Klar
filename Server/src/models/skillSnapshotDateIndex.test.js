import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import SkillSnapshot from "./SkillSnapshot.js";

// ── In-memory Mongo lifecycle ────────────────────────────────────
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // autoIndex OFF — the beforeEach syncIndexes() below is the sole index builder.
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await SkillSnapshot.deleteMany({});
  await SkillSnapshot.syncIndexes();
});

const DAY = new Date(Date.UTC(2026, 0, 1));

describe("SkillSnapshot { skill, date } uniqueness", () => {
  it("rejects a duplicate (skill, date) row", async () => {
    await SkillSnapshot.create({ skill: "react", date: DAY, postingCount: 5 });
    await expect(
      SkillSnapshot.create({ skill: "react", date: DAY, postingCount: 7 }),
    ).rejects.toThrow(/duplicate key|E11000/i);
  });

  it("allows the same skill on different days", async () => {
    await SkillSnapshot.create({ skill: "react", date: DAY, postingCount: 5 });
    const other = new Date(Date.UTC(2026, 0, 2));
    await expect(
      SkillSnapshot.create({ skill: "react", date: other, postingCount: 6 }),
    ).resolves.toBeTruthy();
  });

  it("does not constrain legacy rows that have no date (partial index)", async () => {
    const capturedAt = new Date();
    await SkillSnapshot.create({ skill: "react", count: 1, capturedAt });
    // A second dateless legacy row for the same skill must be allowed.
    await expect(
      SkillSnapshot.create({ skill: "react", count: 2, capturedAt }),
    ).resolves.toBeTruthy();
  });
});

describe("SkillSnapshot date TTL retention", () => {
  it("has a ~400-day TTL index on date with a partial filter on date existence", async () => {
    const indexes = await SkillSnapshot.collection.indexes();
    const dateTtls = indexes.filter((idx) => {
      const keys = Object.keys(idx.key || {});
      return keys.length === 1 && keys[0] === "date" && typeof idx.expireAfterSeconds === "number";
    });
    expect(dateTtls).toHaveLength(1);
    const ttl = dateTtls[0];
    // 400 days in seconds. Must exceed the 12-month (~365d) forecast lookback.
    expect(ttl.expireAfterSeconds).toBe(60 * 60 * 24 * 400);
    expect(ttl.expireAfterSeconds).toBeGreaterThan(60 * 60 * 24 * 365);
    expect(ttl.partialFilterExpression).toMatchObject({ date: { $type: "date" } });
  });
});
