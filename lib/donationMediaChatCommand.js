// What a moderator's chat command (`!clip hide|show|pause|play|skip`, TwitchBot
// commands/donationMediaControl.js) does to a channel's queue - the pure half, so it can be tested
// without a socket or Mongo. realtime/donationMediaManager.js reads the commands off
// DonationMediaChatCommands (db/donationMediaChatCommandsRepo.js) and calls apply() for each.
//
// A command names the clip it was typed about (`itemId`, read by the bot off the now-playing row).
// It applies only while that clip is still the current one: chat is seconds behind the stream, and
// two moderators typing "!clip skip" at the same clip must skip one clip, not two. A command about
// a clip that is gone is refused as `changed`, which the bot reports back to chat.
//
// Every outcome is a status the bot turns into a chat line:
//   done      - the queue changed
//   noop      - it already was so (paused, hidden, playing...)
//   changed   - the named clip is no longer the current one, or nothing plays

const ACTIONS = ["hide", "show", "pause", "play", "skip"];

function isAction(value) {
  return ACTIONS.includes(value);
}

// queue: lib/donationMediaQueue.js's MediaQueue. Returns { status }.
function apply(queue, { action, itemId, by = null } = {}) {
  if (!isAction(action)) return { status: "invalid" };
  const current = queue.current;
  if (!current || !Number.isInteger(itemId) || current.id !== itemId) return { status: "changed" };

  switch (action) {
    case "hide":
      if (queue.cover === "hide") return { status: "noop" };
      queue.setCover("hide");
      return { status: "done" };
    case "show":
      if (!queue.cover) return { status: "noop" };
      queue.setCover(null);
      return { status: "done" };
    case "pause":
      if (queue.paused) return { status: "noop" };
      queue.pause();
      return { status: "done" };
    case "play":
      if (!queue.paused) return { status: "noop" };
      queue.resume();
      return { status: "done" };
    case "skip":
      queue.skip(by);
      return { status: "done" };
    default:
      return { status: "invalid" };
  }
}

// --- !sr: a song request from chat (TwitchBot commands/songRequest.js) ------------------------------
// Not a command about the clip playing, so it has no itemId: the row carries the viewer's link
// (`videoId`, as typed - checked again here). Outcomes, each turned into a chat line by the bot:
//   done      - queued; the row also gets `result: { title, position }`
//   disabled  - the channel switched !sr off      forbidden - "moderators only" and they are not one
//   invalid   - not a YouTube link                noEmbed   - the video cannot play in the OBS player
//   limit     - the viewer already has SR_PER_USER requests waiting
//   full      - the queue is at its ceiling
const SONG_REQUEST_ACTION = "add";
// Per viewer, waiting in the queue at once. Moderators are not limited: they are the ones who
// would otherwise clean the queue up.
const SR_PER_USER = 2;

function isSongRequest(action) {
  return action === SONG_REQUEST_ACTION;
}

// How many requests from chat by this login are waiting in the queue (not the one playing).
function waitingRequestsOf(queue, login) {
  const name = String(login || "").toLowerCase();
  return queue.queue.filter((item) => item.viaChat && String(item.addedBy || "").toLowerCase() === name).length;
}

module.exports = { apply, isAction, ACTIONS, SONG_REQUEST_ACTION, SR_PER_USER, isSongRequest, waitingRequestsOf };
