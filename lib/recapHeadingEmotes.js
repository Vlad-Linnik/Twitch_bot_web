// The emote drawn after each heading of the year recap (views/annualRecap.ejs, annualRecapMe.ejs) -
// the chat's own vocabulary as the section's mood. One list, so a different pick is a one-line
// change.
//
// Names are matched exactly against the channel's emote pictures (twitch/emoteImages.js: 7TV,
// BTTV, FFZ, Twitch). A channel that does not have the emote simply gets the heading without one -
// the name is never printed as text, because a heading reading "Голоса года peepoChat" is worse
// than no emote at all.
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
  categories: "GIGACHAD",
  moderation: "Madge",
  picks: "peepoGiggles",
  // personal page
  presence: "peepoHappy",
  firstMessage: "hiii",
  yourWords: "NOTED",
  yourEmotes: "peepoLove",
  partners: "frenn",
  record: "monkaS",
  extras: "EZ",
};

module.exports = { RECAP_HEADING_EMOTES };
