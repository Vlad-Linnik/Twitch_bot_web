// Turns the page's already-loaded stats into the four hero tiles the throne theme renders.
// Pure and locale-free on purpose: it decides WHICH number each tile shows and whether that
// number exists at all, while the view decides how to format it (toLocaleString needs the
// request's locale, which has no business in a rule this module wants tests for).
//
// A tile can legitimately have no value. Two different reasons, one presentation:
//   - the target user hid that panel (routes/userDashboard.js skips the query entirely, so the
//     data arrives here as null - see lib/privacy.js), or
//   - they have no such history yet (never mentioned, no tracked emotes, no rank).
// Both render as a dash. A hidden panel must not be inferable from the hero, which is exactly
// what a "0" instead of a dash would leak.
const KINDS = {
  rank: "rank",
  messages: "number",
  mentions: "number",
  firstSeen: "date",
  nicknames: "number",
  topEmote: "text",
};

function buildTrophies(trophyKeys, { standing, mentions, clouds, identity, nicknames }) {
  return (trophyKeys || []).map((key) => {
    const tile = { key, kind: KINDS[key] || "text", value: null, secondary: null };

    switch (key) {
      case "rank":
        // A user with no messages in this channel has no rank at all, not rank #last.
        if (standing?.rank) {
          tile.value = standing.rank;
          tile.secondary = standing.totalChatters;
        }
        break;
      case "messages":
        if (standing) tile.value = standing.totalMessages;
        break;
      case "mentions":
        // All-time, like every other tile: the caller hands this module an all-time read rather
        // than the period-shaped one the @mentions panel below the hero is drawing (see
        // routes/userDashboard.js). The hero has no period switch of its own.
        if (mentions) tile.value = mentions.total;
        break;
      case "firstSeen":
        // UserIdentities.firstSeen is when the BOT first saw this person, which is not their
        // Twitch account age - the label ("in the chronicle since") says so rather than
        // implying a number we don't have.
        if (identity?.firstSeen) tile.value = identity.firstSeen;
        break;
      case "nicknames":
        tile.value = Array.isArray(nicknames) ? nicknames.length : 0;
        break;
      case "topEmote":
        // getUserClouds returns emotes already sorted by count, and the caller passes the copy
        // that has been through withEmoteImages - the tile shows the emote itself and only falls
        // back to its name when the image map has no entry (an emote the channel stopped
        // tracking, or a 7TV set that has never been synced).
        if (clouds?.emotes?.length) {
          tile.value = clouds.emotes[0].word;
          tile.secondary = clouds.emotes[0].imageUrl || null;
        }
        break;
      default:
        break;
    }

    return tile;
  });
}

module.exports = { buildTrophies };
