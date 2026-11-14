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

module.exports = { apply, isAction, ACTIONS };
