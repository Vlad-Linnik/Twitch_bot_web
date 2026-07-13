// config/statsLimits.js's period helpers gate every period-switchable read path (clouds, top
// chatters, moderator summary). periodStart moved here from wordStatsRepo precisely so this
// window computation could be pinned without Mongo.
const test = require("node:test");
const assert = require("node:assert/strict");

const { periodStart, resolvePeriod, PERIODS, DEFAULT_PERIOD } = require("../config/statsLimits");
const { dayBucket } = require("../lib/textStats");

test("periodStart: 'all' is null - the signal to read the precomputed all-time row", () => {
  assert.equal(periodStart("all"), null);
});

test("periodStart: named periods land on the local-noon day bucket, matching the bot's rows", () => {
  for (const [period, days] of [["day", 1], ["week", 7], ["month", 30]]) {
    const start = periodStart(period);
    assert.deepEqual(start, dayBucket(new Date(Date.now() - days * 86400000)), period);
    assert.equal(start.getHours(), 12, `${period} must bucket at local noon`);
  }
});

test("periodStart: any real window starts after the epoch, so the all-time sentinel is excluded", () => {
  for (const period of ["day", "week", "month"]) {
    assert.ok(periodStart(period) > new Date(0));
  }
});

test("periodStart: an unknown period falls back to the week window, like resolvePeriod's default", () => {
  assert.deepEqual(periodStart("bogus"), periodStart("week"));
});

test("resolvePeriod: caps ranges at max but never downgrades 'all' (it is the cheapest read)", () => {
  assert.equal(resolvePeriod("month", { max: "week" }), "week");
  assert.equal(resolvePeriod("all", { max: "week" }), "all");
  assert.equal(resolvePeriod("nonsense"), DEFAULT_PERIOD);
  assert.ok(PERIODS.includes(DEFAULT_PERIOD));
});
