// The music graph's journal: one row per background track that ended (db/musicEventsRepo.js), with what
// it was chosen on and what became of it. Pure. It is what a change of the choosing is judged by, so a
// row carries the numbers of that moment, not references to what will have changed by the time anyone
// looks.
const SKIPS = new Set(["skipEarly", "skipMid"]);
const JUDGED = new Set(["listened", "skipEarly", "skipMid", "skipLate", "through"]);

const num = (v, digits = 4) => (Number.isFinite(v) ? Number(v.toPrecision(digits)) : null);

// Why an ended track does not count as heard to the end; null when it says something about the channel's
// taste.
function notCounted(outcome, { play, live }) {
  if (outcome !== "through") return null;
  if (live === false) return "offline";
  return play && play.heard < play.elapsed * 0.9 ? "muted" : "seeked";
}

// item: the queue's; how: its onFinished's; mode: "radio" | "endless" | "feed" | "playlist".
function eventOf({ channelId, item, how, outcome, author = "", node = null, artist = "", mode, live = null, idleMs = null, now = Date.now() }) {
  const entry = item.upNextEntry || null;
  const play = how.play || null;
  const progress = how.progress || {};
  return {
    channelId: String(channelId),
    videoId: item.videoId,
    title: String(item.title || "").slice(0, 200),
    author: String((entry && entry.author) || author || "").slice(0, 100),
    node,
    artist,
    source: entry ? entry.source || entry.via : "playlist",
    via: entry ? entry.via : "playlist",
    mode,
    why: entry && entry.why ? { ...entry.why, from: entry.from || null } : null,
    outcome: outcome || "error",
    counted: notCounted(outcome, { play, live }) || true,
    by: how.by ? "person" : null,
    heard: play ? Math.round(play.heard) : null,
    elapsed: play ? Math.round(play.elapsed) : null,
    duration: progress.duration > 0 ? Math.round(progress.duration) : null,
    startedAt: play && play.startedAt ? new Date(play.startedAt) : null,
    endedAt: new Date(now),
    live,
    volume: Number.isFinite(how.volume) ? how.volume : null,
    idleMs: Number.isFinite(idleMs) ? Math.round(idleMs) : null,
  };
}

// --- what the admin page shows -------------------------------------------------------------------

const band = (v, edges, names) => names[edges.findIndex((e) => v < e) === -1 ? edges.length : edges.findIndex((e) => v < e)];

// How each row is sorted into groups: name -> (event) => group, or null to leave it out.
const CUTS = {
  source: (e) => e.source,
  mode: (e) => e.mode,
  closeness: (e) => (e.why && Number.isFinite(e.why.reach) ? band(e.why.reach, [0.1, 0.25, 0.5], ["0-0.1", "0.1-0.25", "0.25-0.5", "0.5+"]) : null),
  novelty: (e) => (e.why ? (e.why.unheard ? "new" : "known") : null),
  genre: (e) => (e.why && Number.isFinite(e.why.sim) ? band(e.why.sim, [0.15, 0.45, 0.75], ["0-0.15", "0.15-0.45", "0.45-0.75", "0.75+"]) : null),
  place: (e) => (e.why && Number.isFinite(e.why.pos) ? String(e.why.pos + 1) : null),
  hour: (e) => (Number.isFinite(e.hour) ? band(e.hour, [1, 2, 3, 5], ["0-1", "1-2", "2-3", "3-5", "5+"]) : null),
  asked: (e) => (Number.isFinite(e.asked) ? (e.asked > 0 ? "asked" : "notAsked") : null),
};

// { total: { n, skips }, cuts: { <cut>: { <group>: { n, skips } } }, arms: { <feature>: { on, off } }, outcomes }
function summarize(events) {
  const out = { total: { n: 0, skips: 0 }, outcomes: {}, notCounted: {}, cuts: {}, arms: {} };
  const add = (box, skipped) => {
    box.n++;
    if (skipped) box.skips++;
  };
  for (const e of events) {
    out.outcomes[e.outcome] = (out.outcomes[e.outcome] || 0) + 1;
    if (typeof e.counted === "string") out.notCounted[e.counted] = (out.notCounted[e.counted] || 0) + 1;
    if (!JUDGED.has(e.outcome)) continue;
    const skipped = SKIPS.has(e.outcome);
    add(out.total, skipped);
    for (const [name, cut] of Object.entries(CUTS)) {
      const group = cut(e);
      if (group === null || group === undefined) continue;
      const groups = (out.cuts[name] = out.cuts[name] || {});
      add((groups[group] = groups[group] || { n: 0, skips: 0 }), skipped);
    }
    for (const [feature, on] of Object.entries((e.why && e.why.arms) || {})) {
      const arm = (out.arms[feature] = out.arms[feature] || { on: { n: 0, skips: 0 }, off: { n: 0, skips: 0 } });
      add(on ? arm.on : arm.off, skipped);
    }
  }
  return out;
}

module.exports = { eventOf, notCounted, summarize, SKIPS, JUDGED, num };
