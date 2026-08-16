// Least-squares slope of y over x (x in hours since the first sample). More stable than a bare
// first/last diff when samples are noisy - a compaction momentarily shrinking storageSize, or one
// hour where a Mongo checkpoint ate 200 MB of RAM and gave it back. Returns units-of-y per hour.
//
// Shared by lib/diskUsageAnalysis.js and lib/memoryUsageAnalysis.js, which fit the same line
// through very different data; it lives here rather than in one of them so neither has to require
// the other.
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

module.exports = { slopePerHour };
