const express = require("express");
const env = require("../config/env");
const channelsRepo = require("../db/channelsRepo");
const userProfileService = require("../db/userProfileService");

const router = express.Router();

// The creator's name is rendered in their own Twitch chat colour and links to their channel.
//
// This is the CREATOR's colour, not the visitor's - res.locals.userDisplayColor (from
// middleware/navMenu.js) describes whoever is logged in, and /about is a public page that usually
// has nobody logged in at all. So it's resolved independently: login -> Channels.ownerId (numeric
// id) -> the shared display profile. The colour policy itself lives in db/userProfileService.js;
// it used to be copy-pasted here, which is how it drifted out of sync with the user dashboard.
//
// Fails soft: if Twitch is unreachable or the channel isn't registered, the name still renders,
// just as a plain uncoloured link. An About page must not 500 over a colour lookup.
async function resolveCreator() {
  const login = env.creatorLogin;

  try {
    const channel = await channelsRepo.findByLogin(login);
    if (!channel?.ownerId) return { login, color: null };

    const { color } = await userProfileService.getDisplayProfile(channel.ownerId);
    return { login, color };
  } catch (err) {
    console.error("[about] Failed to resolve creator profile:", err.message);
    return { login, color: null };
  }
}

router.get("/about", async (req, res, next) => {
  try {
    res.render("about", { creator: await resolveCreator() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
