// Bearer-token-gated JSON API for the Unban Bureau (Бюро амнистии) data - meant for an external
// tool/assistant to fetch and analyze a dossier, never for the browser session flow the rest of this
// app uses. See middleware/adminApiAuth.js for the auth model.
//
// IT CANNOT ACT ON THE QUEUE. There are deliberately no decision/vote/sniper endpoints here: nothing
// reachable through this token approves an appeal, times anyone out, or changes what the bot will do
// to a Twitch account. Those stay on routes/unbanBureau.js's session-gated tier-2 access, where a
// named moderator holding the desk shift is accountable for each one.
//
// The one write it does have - PUT .../opinions - is not an exception to that. It stores two
// advisory speeches for the moderator to read on the desk's fourth sheet (web-only collection, see
// db/unbanOpinionsRepo.js). A case decides identically whether or not they were ever written; they
// are commentary, not moderation state.
const express = require("express");
const requireApiToken = require("../middleware/adminApiAuth");
const { adminApiLimiter } = require("../middleware/rateLimiters");
const channelsRepo = require("../db/channelsRepo");
const unbanRequestsRepo = require("../db/unbanRequestsRepo");
const unbanDossierRepo = require("../db/unbanDossierRepo");
const unbanOpinionsRepo = require("../db/unbanOpinionsRepo");
const { parseOpinions, MAX_OPINION_CHARS } = require("../lib/unbanOpinionsValidation");

const router = express.Router();

router.use("/admin/api", adminApiLimiter, requireApiToken);

// This app mounts no global express.json() - app.js parses urlencoded bodies only, because every
// browser-facing form on the site is a form. The one JSON body in the codebase is this endpoint's,
// so the parser is scoped to it rather than added app-wide, for the same reason routes/games.js
// mounts its own: a parser mounted globally is a buffer every other route then has to defend.
// 32kB is far above the three capped speeches (MAX_OPINION_CHARS each) this ever carries.
const opinionsBody = express.json({ limit: "32kb" });

// Resolves :id to {unbanCase, channel} or answers the request itself. Shared by the three
// case-scoped endpoints below, which otherwise repeat the same two lookups and two 404s.
async function loadCase(req, res) {
  const unbanCase = await unbanRequestsRepo.findById(req.params.id);
  if (!unbanCase) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const channel = await channelsRepo.findByChannelId(unbanCase.channelId);
  if (!channel) {
    res.status(404).json({ error: "channel_not_found" });
    return null;
  }
  return { unbanCase, channel };
}

// GET /admin/api/unban-requests?channel=<login>
router.get("/admin/api/unban-requests", async (req, res, next) => {
  try {
    const login = typeof req.query.channel === "string" ? req.query.channel.trim().toLowerCase() : "";
    if (!login) return res.status(400).json({ error: "channel_required" });

    const channel = await channelsRepo.findByLogin(login);
    if (!channel) return res.status(404).json({ error: "channel_not_found" });

    const requests = await unbanRequestsRepo.listPendingForChannel(channel.channelId);
    res.json({ ok: true, channel: channel.channelLogin, requests });
  } catch (err) {
    next(err);
  }
});

// GET /admin/api/unban-requests/:id/dossier
router.get("/admin/api/unban-requests/:id/dossier", async (req, res, next) => {
  try {
    const loaded = await loadCase(req, res);
    if (!loaded) return;
    const { unbanCase, channel } = loaded;

    const dossier = await unbanDossierRepo.getDossier(channel.channelLogin, unbanCase, {
      before: req.query.before || null,
    });

    // twitchModLogs stripped for the same reason listPendingForChannel projects it out server-side:
    // it's the largest field on the doc and everything useful in it is already surfaced,
    // unduplicated, inside `dossier` (counts, actions, modComments, log, etc.).
    const { twitchModLogs, ...request } = unbanCase;
    res.json({ ok: true, channel: channel.channelLogin, request, dossier });
  } catch (err) {
    next(err);
  }
});

// GET /admin/api/unban-requests/:id/brief
//
// The dossier endpoint above, rendered down to the plain-text brief the two agents actually read.
// It exists as its own endpoint rather than as formatting done by the caller because the brief's
// wording is load-bearing (see lib/unbanCaseBrief.js's header: coverage caveats, three-state fields,
// the "reason not given is normal" note) - a caller that assembled its own would quietly drop the
// parts that stop an agent reasoning from a fact the moderator can't see.
//
// `?format=text` returns it as text/plain, which is how it's read by eye and saved to a file; the
// default JSON form is what the driver posts around.
router.get("/admin/api/unban-requests/:id/brief", async (req, res, next) => {
  try {
    const loaded = await loadCase(req, res);
    if (!loaded) return;
    const { unbanCase, channel } = loaded;

    // Composed in the repo so this and the moderator-facing "заказать разбор" button read the
    // same brief - see db/unbanDossierRepo.js's getCaseBrief().
    const brief = await unbanDossierRepo.getCaseBrief(channel.channelLogin, unbanCase);

    if (req.query.format === "text") {
      res.type("text/plain; charset=utf-8").send(brief);
      return;
    }
    res.json({
      ok: true,
      channel: channel.channelLogin,
      caseId: String(unbanCase._id),
      applicant: unbanCase.userDisplayName || unbanCase.userLogin || null,
      brief,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /admin/api/unban-requests/:id/opinions
//
// Stores the finished speeches. Idempotent by design - the driver is re-runnable by hand and a
// second run replaces the sheet rather than adding one (db/unbanOpinionsRepo.js's unique caseId).
router.put("/admin/api/unban-requests/:id/opinions", opinionsBody, async (req, res, next) => {
  try {
    const loaded = await loadCase(req, res);
    if (!loaded) return;
    const { unbanCase, channel } = loaded;

    const parsed = parseOpinions(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: "invalid_opinions", reason: parsed.reason, maxChars: MAX_OPINION_CHARS });
    }

    const doc = await unbanOpinionsRepo.upsertOpinions(
      String(unbanCase._id),
      { channelId: channel.channelId, channelLogin: channel.channelLogin },
      parsed.value
    );
    res.json({ ok: true, channel: channel.channelLogin, caseId: String(unbanCase._id), opinions: doc });
  } catch (err) {
    next(err);
  }
});

// GET /admin/api/unban-requests/:id/opinions - so a driver can check what's already stored (and skip
// a case it has argued) without going through the moderator-facing page.
router.get("/admin/api/unban-requests/:id/opinions", async (req, res, next) => {
  try {
    const loaded = await loadCase(req, res);
    if (!loaded) return;

    const opinions = await unbanOpinionsRepo.findByCaseId(String(loaded.unbanCase._id));
    res.json({ ok: true, caseId: String(loaded.unbanCase._id), opinions: opinions || null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
