// Viewer suggestions for a channel's movie (later game) cards - the pure rules behind
// routes/movies.js's suggestion routes, testable without a database.
//
//   - Who may suggest: levels 0-2 always; anyone else logged in only if they have written in this
//     channel's chat (the same UserLifetimeStats row that makes a viewer's rating count). A fresh
//     account made to flood the list has never been in the chat.
//   - At most MAX_OPEN_SUGGESTIONS waiting ("suggested") per person per channel and kind.
//   - No duplicates in ANY status: an external id match, or the same title (either title, any
//     language) with the same year. What the person is told depends on the status of the card they
//     ran into - watched, open (go vote for it), or rejected (here is why).
//   - Votes are promote (+1) / not now (-1); clicking your own vote again takes it back, the other
//     button flips it. Everyone may vote, the author included, and the score starts at zero; only
//     the votes of people who have chatted in the channel count, the rest are kept and may count
//     later. No threshold hides or folds anything - a downvoted suggestion only sorts lower.
const media = require("./mediaValidation");

const MAX_OPEN_SUGGESTIONS = 3;
const NOTE_MAX = 500;
const REJECT_REASON_MAX = 300;
// The statuses on the suggestions tab; `rejected` has its own tab for levels 0-2.
const OPEN_STATUSES = ["suggested", "accepted"];
// Statuses a suggestion can be voted on in: still a candidate, or planned (the order of the plan).
const VOTABLE_STATUSES = new Set(["suggested", "accepted"]);

function canSuggest({ loggedIn, permission, chatted }) {
  if (!loggedIn) return false;
  if (Number.isInteger(permission) && permission <= 2) return true;
  return Boolean(chatted);
}

function cleanNote(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, NOTE_MAX);
}

// The suggestion form: the card fields a viewer may fill (title, original title, year, type, IMDb
// id, 18+) plus the note. Status, progress, the recording link and the streamer's fields are not
// the suggester's to set and are not read at all.
function parseSuggestionForm(body) {
  const { errors, value } = media.parseMediaForm(
    {
      title: body.title,
      originalTitle: body.originalTitle,
      year: body.year,
      mediaType: body.mediaType,
      imdbId: body.imdbId,
      nsfw: body.nsfw,
      status: "done", // parseMediaForm validates a status; the suggestion overrides it below
    },
    { canWriteStreamerFields: false }
  );
  return {
    errors,
    value: { ...value, status: "suggested", recordingUrl: null, progress: null, note: cleanNote(body.note) || null },
  };
}

function cleanRejectReason(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, REJECT_REASON_MAX) : "";
}

// The existing card a candidate duplicates, or null. `candidate` = {imdbId, tmdbId, tmdbType,
// shikimoriId, title, originalTitle, year}; `existing` = the channel's cards of this kind, any
// status. Titles compare after lib/mediaValidation.js's normalization (case, ё/е, spaces); a year
// missing on either side does not prevent a title match - "Начало" with no year next to
// "Начало (2010)" is the same suggestion far more often than a different film.
function findDuplicate(candidate, existing) {
  const ext = candidate || {};
  const titles = [ext.title, ext.originalTitle].map(media.normalizeSearchText).filter(Boolean);
  for (const item of existing) {
    const e = item.external || {};
    if (ext.imdbId && e.imdbId === ext.imdbId) return item;
    if (ext.tmdbId && e.tmdbId === ext.tmdbId && e.tmdbType === ext.tmdbType) return item;
    if (ext.shikimoriId && e.shikimoriId === ext.shikimoriId) return item;
    const theirs = [item.title, item.originalTitle].map(media.normalizeSearchText).filter(Boolean);
    const sameTitle = titles.some((t) => theirs.includes(t));
    const yearsAgree = !ext.year || !item.year || ext.year === item.year;
    if (sameTitle && yearsAgree) return item;
  }
  return null;
}

// What to tell the person about the duplicate they hit.
function duplicateOutcome(item) {
  if (item.status === "done") return "watched";
  if (item.status === "rejected") return "rejected";
  return "open";
}

// The vote a click produces: the same button again takes the vote back (0), the other one sets it.
// "clear" is what the no-JS form posts for the already-pressed button.
function nextVote(previous, requested) {
  if (requested === "clear") return 0;
  const want = Number(requested);
  if (want !== 1 && want !== -1) return null;
  return previous === want ? 0 : want;
}

// How one person's vote change moves the card's counted {score, up, down}. Only a COUNTED vote is
// in the totals; `previous` is the stored vote or null.
function voteDelta(previous, nextValue, nextCounted) {
  const before = previous && previous.counted ? previous.value : 0;
  const after = nextCounted ? nextValue : 0;
  return {
    score: after - before,
    up: (after === 1 ? 1 : 0) - (before === 1 ? 1 : 0),
    down: (after === -1 ? 1 : 0) - (before === -1 ? 1 : 0),
  };
}

const isVotable = (item) => VOTABLE_STATUSES.has(item.status);

// A rating of the film itself is fine anywhere but on a rejected card: on a suggestion it is the
// viewers' "I have seen it, it is good", which is exactly what helps decide.
const isRatable = (item) => item.status !== "rejected";

module.exports = {
  MAX_OPEN_SUGGESTIONS,
  NOTE_MAX,
  REJECT_REASON_MAX,
  OPEN_STATUSES,
  canSuggest,
  cleanNote,
  parseSuggestionForm,
  cleanRejectReason,
  findDuplicate,
  duplicateOutcome,
  nextVote,
  voteDelta,
  isVotable,
  isRatable,
};
