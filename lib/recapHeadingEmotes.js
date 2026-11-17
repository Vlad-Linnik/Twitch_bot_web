// The emote drawn after each heading of the year recap (views/annualRecap.ejs, annualRecapMe.ejs) -
// the chat's own vocabulary as the section's mood. One list, so a different pick is a one-line
// change.
//
// An entry is either
//   - a name, matched exactly against the channel's emote pictures (twitch/emoteImages.js: 7TV,
//     BTTV, FFZ, Twitch) - a channel without that emote gets the heading without one, and the
//     name is never printed as text, because "Голоса года peepoChat" is worse than no emote; or
//   - { name, sevenTv: <emote id> } - a 7TV emote the channel's own sets may not have, drawn from
//     7TV's CDN by id. The id pins one particular upload: 7TV has several emotes under most names
//     (four "BONKTHEMODS" by four owners), and a name alone would draw whichever one a channel
//     happens to carry.
const SEVEN_TV_CDN = "https://cdn.7tv.app/emote";

const RECAP_HEADING_EMOTES = {
  // channel page
  rhythm: "catJAM",
  chatters: "peepoChat",
  pairs: "frenn",
  words: "NOTED",
  newWords: "Hmm",
  clips: "POGGERS",
  moments: "KEKW",
  commands: "Clap",
  first: "hiii",
  categories: { name: "peepoSitGamer", sevenTv: "01FTMQN17G0004Z31N7KWZQX64" },
  siteGames: "EZ",
  moderation: { name: "BONKTHEMODS", sevenTv: "01F71TBBSG000DNB9RV7R83JG9" },
  picks: "peepoGiggles",
  // moderation tiles
  tileTimeouts: { name: "MUTED", sevenTv: "01GTWECC7R0004HAYCKWMHR2Q9" },
  tileBans: { name: "peepoJail", sevenTv: "01F6R7M1YG000ATZXMPM5V0YBM" },
  tileAmnesty: { name: "peepoFree", sevenTv: "01FAFYNB9R0009VNZY7D3CCBGF" },
  // personal page
  presence: "peepoHappy",
  firstMessage: "hiii",
  yourWords: "NOTED",
  yourEmotes: "peepoLove",
  partners: "frenn",
  record: "monkaS",
};

// key -> { name, url } for the emotes that can be drawn on this channel; keys without a picture are
// left out. `images` is the channel's emote Map (name -> url).
function resolveHeadingEmotes(images, table = RECAP_HEADING_EMOTES) {
  const out = {};
  for (const [key, entry] of Object.entries(table)) {
    if (entry && typeof entry === "object") {
      const own = images && typeof images.get === "function" ? images.get(entry.name) : null;
      out[key] = { name: entry.name, url: own || `${SEVEN_TV_CDN}/${entry.sevenTv}/2x.webp` };
    } else {
      const url = images && typeof images.get === "function" ? images.get(entry) : null;
      if (url) out[key] = { name: entry, url };
    }
  }
  return out;
}

module.exports = { RECAP_HEADING_EMOTES, resolveHeadingEmotes };
