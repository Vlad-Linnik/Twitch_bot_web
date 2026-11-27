// Why the OBS player could not play a clip, put into words for the history.
//
// The player only knows YouTube's error code, and the code does not separate the causes a moderator
// cares about: a video blocked in the streamer's country comes back as the same 150 / 101 as one whose
// owner switched embedding off, and both pass the oEmbed check done when the clip is queued. What does
// separate them is the watch page's `availableCountries` - the list of regions the video plays in, the
// same whichever country the page is read from. Whatever is missing from it is where the video is
// blocked. The server reading the page is not the OBS machine, so the page's own playability status
// says where the SERVER stands, not the streamer; only the country list is taken from it.

// Every region YouTube lists for a video available everywhere (read 2026-11-27 off such a page).
const ALL_REGIONS = Object.freeze([
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE",
  "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD",
  "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM",
  "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
  "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN",
  "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME",
  "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
  "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM",
  "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI",
  "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK",
  "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
]);

// More countries than this is no longer a list worth reading in one line of the history.
const LIST_MAX = 8;

const REGION = /^[A-Z]{2}$/;

// What the watch page says: { available: [codes] | null }. `null` when the page carries no list -
// a removed or private video, or a page YouTube changed.
function parseWatchPage(html) {
  if (typeof html !== "string") return { available: null };
  const m = html.match(/"availableCountries":(\[[^\]]*\])/);
  if (!m) return { available: null };
  try {
    const list = JSON.parse(m[1]);
    if (!Array.isArray(list)) return { available: null };
    return { available: [...new Set(list.filter((c) => typeof c === "string" && REGION.test(c)))] };
  } catch (_) {
    return { available: null };
  }
}

// YouTube's IFrame API error codes (https://developers.google.com/youtube/iframe_api_reference#onError).
function kindOfCode(code) {
  if (code === 100) return "removed";
  if (code === 101 || code === 150) return "embed";
  if (code === 2) return "badId";
  if (code === 5) return "html5";
  return "other";
}

// The reason stored on a history row: { kind, code?, blocked?, only?, blockedCount? }.
// kind "region": `blocked` lists where it does not play, or `only` where it does when that list is the
// shorter one, or just `blockedCount` when both are too long to read.
function failureReason(code, availability) {
  const reason = {};
  if (Number.isInteger(code)) reason.code = code;
  const available = availability && Array.isArray(availability.available) ? availability.available : null;
  if (available && available.length > 0) {
    const have = new Set(available);
    const blocked = ALL_REGIONS.filter((c) => !have.has(c));
    if (blocked.length > 0) {
      reason.kind = "region";
      if (blocked.length <= LIST_MAX) reason.blocked = blocked;
      else if (available.length <= LIST_MAX) reason.only = [...available].sort();
      else reason.blockedCount = blocked.length;
      return reason;
    }
  }
  reason.kind = available && available.length === 0 ? "removed" : kindOfCode(code);
  return reason;
}

module.exports = { ALL_REGIONS, LIST_MAX, parseWatchPage, failureReason, kindOfCode };
