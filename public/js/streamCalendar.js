// Pure date/scale logic behind the stream-session calendar on /<channel>/statistics/chat
// (public/js/stream-chart.js draws it). No DOM in here, so tests/streamCalendar.test.js can load
// the same file Node-side.
//
// It lives under public/ rather than lib/ because it has to run in the BROWSER: a day is the
// VISITOR's local calendar day (the old dropdown already grouped that way), so the server, which
// does not know the visitor's timezone, cannot build either the grid or the per-day totals. Same
// shape as public/js/games/engines/speechMarkup.js - one file, module.exports under Node,
// window.StreamCalendar in the page.
(function () {
  "use strict";

  // ---------------------------------------------------------------------------------------
  // Days. Every day this module hands out is that day's LOCAL NOON - the same rule as
  // lib/textStats.js's dayBucket(), and for the same reason: stepping a date by whole days from
  // noon can never land on the neighbouring day, whereas from midnight a DST switch (23- and
  // 25-hour days) moves it to 23:00 of the day before or 01:00 of the day after. Steps go
  // through setDate(), which keeps the local wall-clock time, never through += 86400000.
  // ---------------------------------------------------------------------------------------
  function noonOf(date) {
    const noon = new Date(date);
    noon.setHours(12, 0, 0, 0);
    return noon;
  }

  function addDays(date, n) {
    const next = noonOf(date);
    next.setDate(next.getDate() + n);
    return next;
  }

  const pad2 = (n) => (n < 10 ? "0" : "") + n;

  // "YYYY-MM-DD" of the date's LOCAL day - the key every map in here is indexed by.
  function dayKey(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function dateFromKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }

  // ---------------------------------------------------------------------------------------
  // Sessions -> days. A stream belongs to the day it STARTED on, whole, even when it runs past
  // midnight: splitting it would put one stream on two days and make "click a day, get its
  // stream" ambiguous. A still-open stream counts up to `now`.
  //
  // Returns Map<dayKey, {key, date, totalMs, sessions[]}>, sessions oldest-first within a day
  // (the order a person reads a day in).
  // ---------------------------------------------------------------------------------------
  function groupSessionsByDay(sessions, now) {
    const nowMs = now == null ? Date.now() : new Date(now).getTime();
    const days = new Map();

    for (const s of sessions || []) {
      const startMs = new Date(s.startedAt).getTime();
      if (!Number.isFinite(startMs)) continue;
      const live = !s.endedAt;
      const endMs = live ? nowMs : new Date(s.endedAt).getTime();
      const durationMs = Math.max(0, (Number.isFinite(endMs) ? endMs : startMs) - startMs);

      const key = dayKey(startMs);
      let day = days.get(key);
      if (!day) {
        day = { key, date: dateFromKey(key), totalMs: 0, sessions: [] };
        days.set(key, day);
      }
      day.totalMs += durationMs;
      day.sessions.push({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt || null, durationMs, live });
    }

    for (const day of days.values()) {
      day.sessions.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    }
    return days;
  }

  // ---------------------------------------------------------------------------------------
  // Shade scale. Days are shaded by their total streamed time against a CAP rather than against
  // the longest day: the cap is the 90th percentile of the day totals (nearest-rank), and
  // anything at or past it gets the darkest shade.
  //
  // Why a percentile cap and not the max: a single 12-hour marathon among ordinary 2-4 hour days
  // would, against the max, push every ordinary day into the bottom two shades - the calendar
  // would say "all pale" about a channel that streams long every day. With the cap the ordinary
  // days keep the whole ramp, and the marathon is still the darkest cell, just not alone.
  //
  // Why not pure quantile ranks (each shade = a quarter of the days): ranks erase the thing the
  // calendar is meant to show. Twenty streams of 3h55m-4h05m would be spread across all four
  // shades as if they differed; against a cap they all read as one long colour, which they are.
  //
  // Why 90 and not 95/99: the page lists a few dozen to a couple of hundred sessions, so the top
  // 10% is a handful of days - exactly the size of the "rare long stream" population the cap is
  // meant to absorb. With fewer than ten days it degenerates to the max, which is the right
  // answer for a channel with too little history to have outliers.
  //
  // Linear above zero (unlike the user-page heatmap's sqrt): that heatmap shades message counts,
  // which are heavy-tailed; durations are bounded by a day, and the cap already removed the tail.
  // ---------------------------------------------------------------------------------------
  const SHADE_LEVELS = 4;
  const CAP_QUANTILE = 0.9;

  function quantileNearestRank(values, q) {
    const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const rank = Math.ceil(q * sorted.length); // 1-based
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
  }

  function buildScale(dayTotals, options) {
    const opts = options || {};
    const levels = opts.levels || SHADE_LEVELS;
    const quantile = opts.quantile == null ? CAP_QUANTILE : opts.quantile;
    return { cap: quantileNearestRank(dayTotals || [], quantile), levels };
  }

  // 0 = no stream that day; 1..levels otherwise. Any day with a stream gets at least level 1, so
  // a 10-minute stream is never mistaken for an empty day.
  function shadeLevel(totalMs, scale) {
    if (!(totalMs > 0) || !(scale.cap > 0)) return 0;
    const t = Math.min(1, totalMs / scale.cap);
    return Math.max(1, Math.min(scale.levels, Math.ceil(t * scale.levels)));
  }

  // ---------------------------------------------------------------------------------------
  // Month grid. `month` is 0-based like Date's. `weekStart` is 0 = Sunday ... 6 = Saturday.
  // Returns weeks x 7 cells; a cell is null outside the month, otherwise {key, day, date}.
  // Always six weeks unless `fixedWeeks: false`: a month spans four to six rows, and a picker
  // whose height changes with the month moves its own buttons out from under the cursor.
  // ---------------------------------------------------------------------------------------
  function monthGrid(year, month, weekStart, options) {
    const fixedWeeks = !options || options.fixedWeeks !== false;
    const first = new Date(year, month, 1, 12, 0, 0, 0);
    const lead = (first.getDay() - (weekStart || 0) + 7) % 7;

    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = first; d.getMonth() === month; d = addDays(d, 1)) {
      cells.push({ key: dayKey(d), day: d.getDate(), date: d });
    }
    const rows = fixedWeeks ? 6 : Math.ceil(cells.length / 7);
    while (cells.length < rows * 7) cells.push(null);

    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  // ---------------------------------------------------------------------------------------
  // Months as {year, month} values.
  // ---------------------------------------------------------------------------------------
  function monthOf(date) {
    const d = new Date(date);
    return { year: d.getFullYear(), month: d.getMonth() };
  }

  function shiftMonth(ym, delta) {
    const total = ym.year * 12 + ym.month + delta;
    return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
  }

  function compareMonth(a, b) {
    return a.year * 12 + a.month - (b.year * 12 + b.month);
  }

  // The navigable range: from the month of the earliest stream day to the month of the latest.
  function monthRange(dayKeys) {
    let min = null;
    let max = null;
    for (const key of dayKeys) {
      if (min === null || key < min) min = key;
      if (max === null || key > max) max = key;
    }
    if (min === null) return null;
    return { first: monthOf(dateFromKey(min)), last: monthOf(dateFromKey(max)) };
  }

  // The stream day before/after `key` (strictly), or null - the keyboard's Left/Right. Keys are
  // "YYYY-MM-DD", so string order IS date order.
  function adjacentDay(sortedKeys, key, direction) {
    if (direction > 0) {
      for (const k of sortedKeys) if (k > key) return k;
    } else {
      for (let i = sortedKeys.length - 1; i >= 0; i--) if (sortedKeys[i] < key) return sortedKeys[i];
    }
    return null;
  }

  // First day of the week for a locale, 0 = Sunday. Intl.Locale's week info where the browser
  // has it (firstDay there is ISO: 1 = Monday ... 7 = Sunday); otherwise Monday, except for the
  // locales that start on Sunday among the ones this site ships.
  function weekStartFor(locale) {
    try {
      const loc = new Intl.Locale(locale);
      const info = typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : loc.weekInfo;
      if (info && info.firstDay) return info.firstDay % 7;
    } catch {
      // fall through
    }
    return /^en(-US)?$/i.test(String(locale || "")) ? 0 : 1;
  }

  const api = {
    SHADE_LEVELS,
    CAP_QUANTILE,
    noonOf,
    addDays,
    dayKey,
    dateFromKey,
    groupSessionsByDay,
    quantileNearestRank,
    buildScale,
    shadeLevel,
    monthGrid,
    monthOf,
    shiftMonth,
    compareMonth,
    monthRange,
    adjacentDay,
    weekStartFor,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    window.StreamCalendar = api;
  }
})();
