// Downloads an image from another site, for a server that must not be turned into a proxy.
//
// The URL handed in has to come from a response OUR server received from a source it chose (TMDB,
// Shikimori, IMDb) - never from a form field. Even so it is checked, and so is every redirect:
// `redirect: "follow"` would check only the first hop, and a source that redirects to an internal
// address would make this a request from our VPS to wherever it points. So redirects are followed
// by hand, each Location re-checked against the same allowlist, at most MAX_REDIRECTS times.
//
// The byte ceiling is enforced while reading, not after: a response is read chunk by chunk and
// abandoned the moment it passes maxBytes, so an endless body never sits whole in memory.
// Content-Length is only a hint (it can lie or be missing).
const DEFAULTS = {
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 10000,
  maxRedirects: 3,
};

class RemoteImageError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * @param {string} url
 * @param {object} opts
 * @param {(url: string) => boolean} opts.isAllowed  allowlist for the first URL and every redirect
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<Buffer>}
 */
async function fetchAllowedImage(url, { isAllowed, fetchImpl = fetch, headers = {}, ...rest } = {}) {
  const { maxBytes, timeoutMs, maxRedirects } = { ...DEFAULTS, ...rest };
  if (typeof isAllowed !== "function") throw new TypeError("fetchAllowedImage: isAllowed is required");

  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowed(current)) throw new RemoteImageError("host_not_allowed", `not allowed: ${hostOf(current)}`);

    const response = await fetchImpl(current, { redirect: "manual", signal, headers });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (response.body) await response.body.cancel().catch(() => {});
      if (!location) throw new RemoteImageError("bad_redirect");
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw new RemoteImageError("http_error", `status ${response.status}`);
    }
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (!type.startsWith("image/")) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw new RemoteImageError("not_an_image", type || "no content-type");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw new RemoteImageError("too_large");
    }
    return readCapped(response.body, maxBytes);
  }
  throw new RemoteImageError("too_many_redirects");
}

async function readCapped(body, maxBytes) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new RemoteImageError("too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid url";
  }
}

module.exports = { fetchAllowedImage, RemoteImageError };
