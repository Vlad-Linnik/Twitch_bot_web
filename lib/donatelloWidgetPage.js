// Reads the Donatello user id off the streamer's media widget page, once, when the setup form is
// saved. The pure halves (link parsing, page parsing) live in lib/donationMedia.js; this module is
// only the request.
//
// The URL is rebuilt from the ids parsed out of the pasted link, so the request can only ever go to
// donatello.to. Redirects are not followed: the widget page answers directly, and a wrong token is
// a plain 404 rather than a redirect anywhere.
const axios = require("axios");
const { donatelloWidgetPageUrl, parseDonatelloWidgetPage } = require("./donationMedia");

const TIMEOUT_MS = 10 * 1000;
const MAX_BYTES = 512 * 1024;

async function resolveDonatelloUserId({ widgetId, token }) {
  let response;
  try {
    response = await axios.get(donatelloWidgetPageUrl({ widgetId, token }), {
      timeout: TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: MAX_BYTES,
      responseType: "text",
      validateStatus: () => true,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
    });
  } catch (err) {
    console.error("[donationMedia] Donatello widget page:", err.message);
    return { ok: false, error: "donatelloUnreachable" };
  }
  if (response.status === 404) return { ok: false, error: "donatelloLink" };
  if (response.status !== 200) {
    console.error("[donationMedia] Donatello widget page: HTTP", response.status);
    return { ok: false, error: "donatelloUnreachable" };
  }
  return parseDonatelloWidgetPage(response.data, widgetId);
}

module.exports = { resolveDonatelloUserId };
