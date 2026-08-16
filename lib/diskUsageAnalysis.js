// Pure trend computation over TwitchBot's hourly DiskUsageSamples (shared db, see ../CLAUDE.md's
// shared-collections table) - kept out of routes/admin.js so it's unit-testable without Mongo,
// same convention as lib/settingsValidation.js. Backs the admin panel's Disk Usage tab.

// The trend line moved to lib/trendFit.js when lib/memoryUsageAnalysis.js started fitting the same
// one; still re-exported here, since this is where callers (and tests) already look for it.
const { slopePerHour } = require('./trendFit');

// samples: DiskUsageSamples docs sorted ASCENDING by timestamp, shaped as written by
// TwitchBot's twitch/diskUsageScheduler.js ({ timestamp, db: {...}, collections: [...] }).
// Returns null if there aren't enough samples yet to fit a trend.
function computeDiskUsageTrends(samples) {
  if (!samples || samples.length < 2) return null;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanHours = (last.timestamp - first.timestamp) / 3_600_000;
  const spanDays = spanHours / 24;

  const fsPoints = samples
    .filter((s) => s.db && s.db.fsUsedSize != null && s.db.fsTotalSize)
    .map((s) => ({
      x: (s.timestamp - first.timestamp) / 3_600_000,
      y: s.db.fsUsedSize,
      total: s.db.fsTotalSize,
      timestamp: s.timestamp,
    }));

  let filesystem = null;
  if (fsPoints.length >= 2) {
    const growthBytesPerDay = slopePerHour(fsPoints) * 24;
    const latest = fsPoints[fsPoints.length - 1];
    const freeBytes = latest.total - latest.y;
    filesystem = {
      usedBytes: latest.y,
      totalBytes: latest.total,
      usedPct: (latest.y / latest.total) * 100,
      growthBytesPerDay,
      daysToFull: growthBytesPerDay > 0 ? freeBytes / growthBytesPerDay : null,
      series: fsPoints.map((p) => ({ timestamp: p.timestamp, usedPct: (p.y / p.total) * 100 })),
    };
  }

  const byCollection = new Map();
  for (const sample of samples) {
    const x = (sample.timestamp - first.timestamp) / 3_600_000;
    for (const col of sample.collections || []) {
      if (!byCollection.has(col.name)) byCollection.set(col.name, []);
      byCollection.get(col.name).push({ x, y: col.totalSize, count: col.count });
    }
  }

  const collections = [];
  for (const [name, points] of byCollection) {
    if (points.length < 2) continue;
    const latest = points[points.length - 1];
    const earliest = points[0];
    collections.push({
      name,
      currentSize: latest.y,
      currentCount: latest.count,
      growthBytesPerDay: slopePerHour(points) * 24,
      growthDocsPerDay: spanDays > 0 ? (latest.count - earliest.count) / spanDays : 0,
    });
  }
  collections.sort((a, b) => b.growthBytesPerDay - a.growthBytesPerDay);

  return { spanHours, firstTimestamp: first.timestamp, lastTimestamp: last.timestamp, filesystem, collections };
}

module.exports = { computeDiskUsageTrends, slopePerHour };
