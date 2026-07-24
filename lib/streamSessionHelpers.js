// Pure helpers behind db/streamSessionsRepo.js's stream-stats chart, split out so they're
// unit-testable without a Mongo connection - same rationale as settingsValidation.js.

// Collapses an ordered list of viewer samples ({timestamp, category}) into contiguous
// same-category ranges, e.g. for the chart's bottom category strip ("Dota 2 | Tetris | IRL").
// `sessionEnd` closes the final segment (the session's own endedAt, or "now" while still live) -
// without it the last category's segment would have no end point to render.
function buildCategorySegments(samples, sessionEnd) {
  const segments = [];
  for (const sample of samples) {
    const last = segments[segments.length - 1];
    if (last && last.category === sample.category) continue;
    if (last) last.endAt = sample.timestamp;
    segments.push({ category: sample.category, startAt: sample.timestamp, endAt: sessionEnd });
  }
  return segments;
}

// Minimum 1-minute buckets, widened just enough to keep the message-rate chart's point count
// under maxPoints regardless of how long the stream ran - a 12-hour "IRL" stream must not force
// the chart to render 720+ points when 400 read exactly as well.
function messageBucketMs(durationMs, maxPoints) {
  const oneMinute = 60000;
  if (durationMs <= 0) return oneMinute;
  const minutesNeeded = Math.ceil(durationMs / maxPoints / oneMinute);
  return Math.max(1, minutesNeeded) * oneMinute;
}

module.exports = { buildCategorySegments, messageBucketMs };
