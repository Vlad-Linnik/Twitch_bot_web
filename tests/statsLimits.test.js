// config/statsLimits.js's period helpers gate every period-switchable read path (clouds, top
// chatters, moderator summary). periodStart moved here from wordStatsRepo precisely so this
// window computation could be pinned without Mongo.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  periodStart,
  moderatorPeriodStart,
  resolvePeriod,
  PERIODS,
  DEFAULT_PERIOD,
} = require("../config/statsLimits");
const { dayBucket } = require("../lib/textStats");

test("periodStart: 'all' is null - the signal to read the precomputed all-time row", () => {
  assert.equal(periodStart("all"), null);
});

test("periodStart: named periods land on the local-noon day bucket, matching the bot's rows", () => {
  for (const [period, days] of [["week", 7], ["month", 30]]) {
    const start = periodStart(period);
    assert.deepEqual(start, dayBucket(new Date(Date.now() - days * 86400000)), period);
    assert.equal(start.getHours(), 12, `${period} must bucket at local noon`);
  }
});

test("periodStart: 'day' is today's calendar bucket, not a rolling 24h window", () => {
  const start = periodStart("day");
  assert.deepEqual(start, dayBucket(new Date()));
  assert.equal(start.getHours(), 12, "day must bucket at local noon");
});

test("periodStart: any real window starts after the epoch, so the all-time sentinel is excluded", () => {
  for (const period of ["day", "week", "month"]) {
    assert.ok(periodStart(period) > new Date(0));
  }
});

test("periodStart: an unknown period falls back to the week window, like resolvePeriod's default", () => {
  assert.deepEqual(periodStart("bogus"), periodStart("week"));
});

test("moderatorPeriodStart: 'day' lands on local midnight, matching ModeratorStatistics' own rows", () => {
  const start = moderatorPeriodStart("day");
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  assert.deepEqual(start, midnight);
  assert.equal(start.getHours(), 0, "day must bucket at local midnight, not noon");
});

test("moderatorPeriodStart: today's midnight-stamped row satisfies the 'day' filter", () => {
  const todayRow = new Date();
  todayRow.setHours(0, 0, 0, 0);
  assert.ok(todayRow >= moderatorPeriodStart("day"));
});

test("moderatorPeriodStart: 'all' is null, same contract as periodStart", () => {
  assert.equal(moderatorPeriodStart("all"), null);
});

test("resolvePeriod: caps ranges at max but never downgrades 'all' (it is the cheapest read)", () => {
  assert.equal(resolvePeriod("month", { max: "week" }), "week");
  assert.equal(resolvePeriod("all", { max: "week" }), "all");
  assert.equal(resolvePeriod("nonsense"), DEFAULT_PERIOD);
  assert.ok(PERIODS.includes(DEFAULT_PERIOD));
});
