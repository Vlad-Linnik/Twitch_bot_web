// Pure trend computation over TwitchBot's hourly MemoryUsageSamples (shared db, see ../CLAUDE.md's
// shared-collections table) - kept out of routes/admin.js so it's unit-testable without Mongo, the
// same convention lib/diskUsageAnalysis.js follows.
//
// The question this answers is not the one the disk tab answers. Disk fills monotonically, so a
// single "used" line and a days-to-full projection describe it. Memory is a floor: what kills the
// bot is the LOWEST available memory in an hour, not the average, because the prod VPS has no swap
// and the kernel resolves a shortage by terminating a process outright. So each hourly bucket
// carries min/avg/max and everything below treats the minimum as the number that matters - the
// average is what the chart's centre line shows, the minimum is what the projection uses.
const { slopePerHour } = require('./trendFit');

function bucketAvg(part) {
  if (!part || !part.sum || !part.samples) return null;
  return part.sum / part.samples;
}

function pct(bytes, total) {
  return total > 0 ? (bytes / total) * 100 : 0;
}

// samples: MemoryUsageSamples docs sorted ASCENDING by timestamp, shaped as written by TwitchBot's
// twitch/memoryUsageScheduler.js. Returns null only when there is nothing at all - unlike the disk
// analysis a single bucket is still worth rendering (it already holds a real min/max spread from
// ~120 samples), it just gets no trend line.
function computeMemoryTrends(samples) {
  if (!samples || samples.length === 0) return null;

  const usable = samples.filter((s) => s && s.totalBytes > 0 && s.available && s.samples > 0);
  if (usable.length === 0) return null;

  const first = usable[0];
  const last = usable[usable.length - 1];
  const spanHours = (last.timestamp - first.timestamp) / 3_600_000;

  const series = usable.map((s) => {
    const avg = bucketAvg({ sum: s.available.sum, samples: s.samples });
    return {
      timestamp: s.timestamp,
      total: s.totalBytes,
      avgBytes: avg,
      minBytes: s.available.min,
      maxBytes: s.available.max,
      avgPct: pct(avg, s.totalBytes),
      minPct: pct(s.available.min, s.totalBytes),
      maxPct: pct(s.available.max, s.totalBytes),
    };
  });

  const totalSamples = usable.reduce((sum, s) => sum + s.samples, 0);

  // The current reading is the newest bucket's last sample, not its average: on the hour in
  // progress the average is diluted by however much of that hour has already elapsed, and the tile
  // is meant to say what the machine looks like right now.
  const currentAvailable = last.available.last != null
    ? last.available.last
    : bucketAvg({ sum: last.available.sum, samples: last.samples });

  const current = {
    at: last.updatedAt || last.timestamp,
    totalBytes: last.totalBytes,
    availableBytes: currentAvailable,
    availablePct: pct(currentAvailable, last.totalBytes),
    usedBytes: last.totalBytes - currentAvailable,
    usedPct: pct(last.totalBytes - currentAvailable, last.totalBytes),
    freeBytes: last.freeBytes != null ? last.freeBytes : null,
    cachedBytes: last.cachedBytes != null ? last.cachedBytes : null,
  };

  // "No swap" and "we couldn't tell" are different claims and the panel must not merge them: on a
  // dev machine with no /proc the fields are simply absent (source 'os'), and rendering that as
  // "swap: none" would put a false alarm on a laptop. Only a real /proc/meminfo read can assert it.
  const swapKnown = last.source === 'meminfo' && last.swapTotalBytes != null;
  const swap = {
    known: swapKnown,
    totalBytes: swapKnown ? last.swapTotalBytes : null,
    freeBytes: swapKnown ? last.swapFreeBytes : null,
    present: swapKnown ? last.swapTotalBytes > 0 : null,
  };

  // The worst moment in the window, which on a swapless machine is the closest it came to an OOM
  // kill. Taken from the buckets' minima, which is the reason they are stored.
  let lowWater = null;
  for (const point of series) {
    if (!lowWater || point.minBytes < lowWater.availableBytes) {
      lowWater = {
        availableBytes: point.minBytes,
        availablePct: point.minPct,
        timestamp: point.timestamp,
      };
    }
  }

  let trend = null;
  if (series.length >= 2) {
    // Fitted through the hourly MINIMA rather than the averages: a slow leak elsewhere on the box
    // shows up in the floor first, and the floor is what has to stay above zero.
    const points = series.map((p) => ({
      x: (p.timestamp - first.timestamp) / 3_600_000,
      y: p.minBytes,
    }));
    const availableBytesPerDay = slopePerHour(points) * 24;
    const headroom = lowWater ? series[series.length - 1].minBytes : 0;
    trend = {
      availableBytesPerDay,
      // Only a shrinking floor projects to anything. Note this is deliberately not called
      // "days to OOM" - it is the date the floor reaches zero if today's slope holds, and a real
      // kill happens somewhat before that.
      daysToExhaustion: availableBytesPerDay < 0 ? headroom / -availableBytesPerDay : null,
    };
  }

  // Per-process RSS, from the newest bucket's snapshot. Empty on a non-Linux host (procfs only) -
  // the view renders nothing rather than a misleading "one process is using everything".
  const processes = (last.processes || []).map((p) => ({
    ...p,
    pct: pct(p.rssBytes, last.totalBytes),
  }));

  const selfPoints = usable
    .filter((s) => s.self && s.self.max != null)
    .map((s) => ({
      timestamp: s.timestamp,
      avgBytes: bucketAvg({ sum: s.self.sum, samples: s.samples }),
      maxBytes: s.self.max,
    }));

  let self = null;
  if (selfPoints.length > 0) {
    const latest = selfPoints[selfPoints.length - 1];
    const peak = selfPoints.reduce((max, p) => (p.maxBytes > max ? p.maxBytes : max), 0);
    self = {
      currentBytes: last.self && last.self.last != null ? last.self.last : latest.avgBytes,
      peakBytes: peak,
      // The bot's own leak detector: the machine's floor can fall for reasons that have nothing to
      // do with this process (mongod's cache, the web panel), and this separates the two.
      growthBytesPerDay: selfPoints.length >= 2
        ? slopePerHour(selfPoints.map((p) => ({
          x: (p.timestamp - first.timestamp) / 3_600_000,
          y: p.avgBytes,
        }))) * 24
        : null,
      series: selfPoints,
    };
  }

  return {
    spanHours,
    bucketCount: usable.length,
    sampleCount: totalSamples,
    firstTimestamp: first.timestamp,
    lastTimestamp: last.timestamp,
    source: last.source || 'os',
    current,
    swap,
    lowWater,
    trend,
    series,
    self,
    processes,
  };
}

// Thins a series for plotting. Every group is COLLAPSED (min of the minima, max of the maxima,
// mean of the averages) rather than sampled - dropping every Nth point would throw away exactly the
// one-hour dip the chart exists to show, which is the same mistake as sampling memory hourly in the
// first place. Over the 90-day window this is the difference between a 2,160-point path and a
// readable one.
function downsampleSeries(series, maxPoints) {
  if (!series || series.length <= maxPoints || maxPoints < 1) return series || [];
  const groupSize = Math.ceil(series.length / maxPoints);
  const out = [];
  for (let i = 0; i < series.length; i += groupSize) {
    const group = series.slice(i, i + groupSize);
    out.push({
      timestamp: group[0].timestamp,
      total: group[0].total,
      avgBytes: group.reduce((sum, p) => sum + p.avgBytes, 0) / group.length,
      minBytes: Math.min(...group.map((p) => p.minBytes)),
      maxBytes: Math.max(...group.map((p) => p.maxBytes)),
      avgPct: group.reduce((sum, p) => sum + p.avgPct, 0) / group.length,
      minPct: Math.min(...group.map((p) => p.minPct)),
      maxPct: Math.max(...group.map((p) => p.maxPct)),
    });
  }
  return out;
}

module.exports = { computeMemoryTrends, downsampleSeries };
