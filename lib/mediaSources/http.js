// JSON over HTTP for the media sources. Three rules for every source:
//   - no redirects followed: an API answering with a redirect is treated as unavailable (the hosts
//     these talk to are fixed, and following one blindly is how a request ends up somewhere else);
//   - a timeout: the editor is waiting on a dropdown, a hung source must not hang the page;
//   - a size ceiling while reading.
// Secrets go in headers only, never in a URL - URLs end up in logs.
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;
// A neutral client name: these services ask automated clients to identify themselves, and nothing
// about the site's owner belongs in it.
const USER_AGENT = "ChatWizardBot-web/1.0";

class SourceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

async function getJson(url, { headers = {}, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const response = await fetchImpl(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
  });
  if (!response.ok) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw new SourceError("http_error", `status ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel().catch(() => {});
      throw new SourceError("too_large");
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new SourceError("bad_json");
  }
}

const yearOf = (date) => {
  const m = typeof date === "string" ? date.match(/^(\d{4})/) : null;
  return m ? Number(m[1]) : null;
};

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

module.exports = { getJson, SourceError, yearOf, str, USER_AGENT };
