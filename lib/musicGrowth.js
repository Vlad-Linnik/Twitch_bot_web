// How much the music graph may grow by itself (lib/musicRadio.js's grow): the part of it nobody is
// waiting for. Growing costs requests now so that later radios need none, and left unbounded it would
// cost more than it saves - so there is a budget, shared by every channel of the process, and each
// channel slows down while what it opens brings little that is new.
//
// In memory on purpose: a restart gives the day's budget back, which is at worst one more day's worth.

// Tracks played between two steps of growth, and where slowing down stops.
const EVERY_MIN = 4;
const EVERY_MAX = 64;
// A step that brought fewer new songs than this (a Mix has two dozen) was a poor one: the neighbourhood
// is known, and the next step waits twice as long.
const POOR_YIELD = 6;
const CHANNEL_PER_DAY = 10;
const SITE_PER_DAY = 40;
const SPACING_MS = 3 * 60 * 1000;

// The site-wide half.
class GrowthBudget {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.day = null;
    this.spent = new Map(); // channelId -> steps today
    this.total = 0;
    this.lastAt = 0;
  }

  // Takes one step for a channel if there is one to take.
  take(channelId) {
    const now = this.now();
    const day = Math.floor(now / (24 * 60 * 60 * 1000));
    if (day !== this.day) {
      this.day = day;
      this.spent.clear();
      this.total = 0;
    }
    const mine = this.spent.get(channelId) || 0;
    if (mine >= CHANNEL_PER_DAY || this.total >= SITE_PER_DAY || now - this.lastAt < SPACING_MS) return false;
    this.spent.set(channelId, mine + 1);
    this.total++;
    this.lastAt = now;
    return true;
  }
}

// One channel's pace.
class GrowthPace {
  constructor() {
    this.every = EVERY_MIN;
    this.since = 0;
  }

  // A track ended; is a step due?
  tick() {
    this.since++;
    return this.since >= this.every;
  }

  // A Mix was opened, for growth or because tracks were needed: either way the graph has just grown.
  opened(newSongs) {
    this.since = 0;
    this.every = newSongs < POOR_YIELD ? Math.min(EVERY_MAX, this.every * 2) : EVERY_MIN;
  }
}

const shared = new GrowthBudget();

module.exports = { GrowthBudget, GrowthPace, shared, EVERY_MIN, EVERY_MAX, POOR_YIELD, CHANNEL_PER_DAY, SITE_PER_DAY, SPACING_MS };
