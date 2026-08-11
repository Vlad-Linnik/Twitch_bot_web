// Pure trend computation over TwitchBot's hourly DiskUsageSamples (shared db, see ../CLAUDE.md's
// shared-collections table) - kept out of routes/admin.js so it's unit-testable without Mongo,
// same convention as lib/settingsValidation.js. Backs the admin panel's Disk Usage tab.

// Least-squares slope of y over x (x in hours since the first sample). More stable than a bare
// first/last diff when hourly samples are noisy (e.g. a compaction momentarily shrinking
// storageSize). Returns bytes/hour (or docs/hour, depending on what y holds).
function slopePerHour(points) {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

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
