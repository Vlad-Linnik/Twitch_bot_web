// /<channel>/unban-bureau - "Бюро разбанов": review Twitch unban appeals with the channel's own
// chat history as a dossier, in a stamp-and-desk game skin.
//
// This app has no Twitch moderation credentials of its own (see ../CLAUDE.md's "Unban requests:
// written by both repos, executed only by the bot"), so stamping a case here only writes
// `resolution.status: 'pending'` onto the shared UnbanRequests document - TwitchBot's
// twitch/unbanRequestScheduler.js (polling every ~60s) is what actually PATCHes Twitch. Same for
// the advisory chat vote: this writes `vote.status: 'requested'`, the bot posts the prompt.
//
// Gated at tier <= 2 like routes/longBans.js - it acts on Twitch moderation state, not statistics.
// Mounted with the other channel-wildcard routers in routes/index.js (before channelRedirect,
// whose bare "/:channel" would otherwise swallow every static page).
//
// Responses are JSON rather than the PRG-redirect pattern the settings pages use: this is a
// keyboard-driven single-screen UI, and a redirect would throw the moderator back to the top of
// the page after every stamp.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const unbanRequestsRepo = require("../db/unbanRequestsRepo");
const unbanDossierRepo = require("../db/unbanDossierRepo");
const unbanBureauShiftRepo = require("../db/unbanBureauShiftRepo");
const unbanOpinionsRepo = require("../db/unbanOpinionsRepo");
const sniperShotsRepo = require("../db/sniperShotsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const emoteImages = require("../twitch/emoteImages");
const { parseEffectiveAt } = require("../lib/unbanDecisionValidation");
const { parseOpinions } = require("../lib/unbanOpinionsValidation");
const { generateOpinions, OpinionsGenerationError } = require("../lib/unbanOpinionsGenerator");
const { requireLevel, requireSettingsEditAccess, computePermission } = require("../middleware/permissions");
const {
  settingsWriteLimiter,
  statsReadLimiter,
  autosaveLimiter,
  opinionsGenerateLimiter,
} = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const env = require("../config/env");

// Built on first use, not at module load: the key is optional, and constructing a client for a
// feature the deployment hasn't configured would trade a clear 503 for a boot-time crash.
let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    const Anthropic = require("@anthropic-ai/sdk");
    anthropicClient = new Anthropic({ apiKey: env.anthropicApiKey });
  }
  return anthropicClient;
}

// Per-moderator ceiling on sniper shots - see the sniper.json handler for why this exists on
// top of settingsWriteLimiter.
const SNIPER_WINDOW_MS = 60 * 1000;
const SNIPER_MAX_PER_WINDOW = 6;
// How recently a shot must have resolved for live.json to still report it. The bot resolves one
// within ~2s of the request, so this only needs to cover a couple of missed polls - long enough
// that a dropped poll doesn't lose the answer, short enough that reopening the page doesn't
// re-announce a shot from earlier in the shift.
const SNIPER_REPORT_WINDOW_MS = 2 * 60 * 1000;

const router = express.Router();

// Same rationale as routes/statistics.js's own copy: requireLevel() renders an HTML error page,
// which is useless inside a fetch().
function requireLevelJson(maxLevel) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.userId ?? null;
      const level = await computePermission(userId, req.params.channel);
      if (level > maxLevel) {
        return res.status(userId ? 403 : 401).json({ error: userId ? "forbidden" : "unauthenticated" });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function loadChannel(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).render("errors/404");
    return null;
  }
  return channel;
}

// Same, for the JSON endpoints - a missing channel there must not render HTML either.
async function loadChannelJson(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return channel;
}

// One moderator per channel at the desk (db/unbanBureauShiftRepo.js explains why). Every write
// endpoint checks the lease as well as the permission tier, so a page that was already open when
// its shift lapsed can't keep stamping verdicts behind the colleague who took over.
async function requireShiftJson(req, res) {
  const holds = await unbanBureauShiftRepo.holds(req.params.channel, req.user.userId);
  if (holds) return true;
  const holder = await unbanBureauShiftRepo.current(req.params.channel);
  res.status(409).json({ error: "shift_taken", holder });
  return false;
}

router.get("/:channel/unban-bureau", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;

    // unbanBureau.enabled off means the channel opted out of the whole feature, not just future
    // Twitch mirroring (TwitchBot/twitch/unbanRequestScheduler.js's own read of this flag) - a 404
    // here is what makes the channel actually disappear from the game, matching the picker/catalog
    // filter in routes/games.js. Read before claiming the desk: no point taking the lease for a
    // page that's about to 404.
    const config = await channelConfigRepo.getConfig(channel.channelLogin);
    if (!config.unbanBureau?.enabled) {
      return res.status(404).render("errors/404");
    }

    // Claiming the desk comes before the (much heavier) queue read: a moderator who is being turned
    // away has no use for the cases, and shouldn't pay for assembling them.
    const shift = await unbanBureauShiftRepo.acquire(channel.channelLogin, req.user);
    if (!shift.ok) {
      return res.status(409).render("unbanBureauBusy", { channel, holder: shift.holder });
    }

    const newestFirst = req.query.sort !== "oldest";
    const cases = await unbanRequestsRepo.listPendingForChannel(channel.channelId, { newestFirst });

    // Nothing to hold the desk for, and the empty state runs no client script - so there'd be
    // nothing renewing the lease either. Give it straight back rather than locking the channel out
    // for a lease's length because someone glanced at an empty queue.
    if (!cases.length) await unbanBureauShiftRepo.release(channel.channelLogin, req.user.userId);

    // Same channel-wide name -> image map the emote cloud and the news comments box resolve
    // against (twitch/emoteImages.js) - so an emote name typed in an appeal or said in chat
    // renders as the actual emote in the log/appeal panes, not its text signature.
    const emoteMap = cases.length
      ? await emoteImages.getEmoteImageMap(channel.channelId).catch(() => new Map())
      : new Map();

    res.render("unbanBureau", {
      channel,
      cases,
      newestFirst,
      emoteList: [...emoteMap].filter(([, url]) => url).map(([name, url]) => ({ name, url })),
      // The vote bar labels the two emotes literally, so the HUD itself tells chat what to type -
      // a translated "For"/"Against" doesn't. Per-channel, hence read here rather than hardcoded.
      voteEmotes: {
        approve: config.unbanBureau?.voteApproveEmote || "VoteYea",
        deny: config.unbanBureau?.voteDenyEmote || "VoteNay",
      },
      heartbeatMs: unbanBureauShiftRepo.SHIFT_HEARTBEAT_MS,
    });
  } catch (err) {
    next(err);
  }
});

// The dossier for one case, fetched lazily as the moderator moves between cases (and again with
// ?before= when they press "load previous" in the log).
router.get(
  "/:channel/unban-bureau/dossier.json",
  statsReadLimiter,
  requireLevelJson(2),
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;

      const unbanCase = await unbanRequestsRepo.findById(req.query.id);
      // The channel check is what stops a valid id from ANOTHER channel being read through this
      // channel's gate - same guard statsRepo.getModActionContext applies.
      if (!unbanCase || String(unbanCase.channelId) !== String(channel.channelId)) {
        return res.status(404).json({ error: "not_found" });
      }

      const dossier = await unbanDossierRepo.getDossier(channel.channelLogin, unbanCase, {
        before: req.query.before || null,
      });

      // The fourth sheet's two speeches ride along here rather than in the page's `data-cases`
      // attribute, for the reason unbanRequestsRepo.listPendingForChannel projects twitchModLogs
      // out: everything embedded in that attribute is paid for by every case in the queue on every
      // page load, and three paragraphs per case is exactly the kind of thing that grew one
      // channel's markup from 1KB to 25KB last time. Most cases have no opinions at all.
      //
      // Skipped when paging the log (?before=): that request is a scroll-back for more chat lines
      // and re-sending an unchanged sheet with each page is pure waste.
      const opinions = req.query.before
        ? undefined
        : await unbanOpinionsRepo.findByCaseId(String(unbanCase._id));

      res.json({ ok: true, dossier, ...(opinions === undefined ? {} : { opinions: opinions || null }) });
    } catch (err) {
      next(err);
    }
  }
);

// Keeps the open page's shift alive. On the autosave limiter rather than the write one: it fires on
// a timer, and a heartbeat burst must never eat the budget the moderator's actual verdicts need.
router.post(
  "/:channel/unban-bureau/shift.json",
  autosaveLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;

      const shift = await unbanBureauShiftRepo.acquire(channel.channelLogin, req.user);
      // Renewal and re-acquisition are the same call, so a moderator whose lease lapsed while the
      // tab was backgrounded simply takes the desk back if nobody else has claimed it.
      if (!shift.ok) return res.status(409).json({ error: "shift_taken", holder: shift.holder });
      res.json({ ok: true, holder: shift.holder });
    } catch (err) {
      next(err);
    }
  }
);

// Hands the desk back when the page is closed, so the next moderator doesn't wait out the lease.
// Sent with navigator.sendBeacon, which cannot set headers - hence no Accept: application/json here
// and the CSRF token travelling in the form body like every other write.
router.post(
  "/:channel/unban-bureau/release.json",
  autosaveLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;
      await unbanBureauShiftRepo.release(channel.channelLogin, req.user.userId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// Stamps a case. Writes the decision for the bot to apply; never calls Twitch.
router.post(
  "/:channel/unban-bureau/decide.json",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;
      if (!(await requireShiftJson(req, res))) return;

      const decision = req.body.decision;
      if (decision !== "approved" && decision !== "denied") {
        return res.status(400).json({ error: "bad_decision" });
      }

      // "решение вступает в силу" - only meaningful for an approval; a denial is never scheduled,
      // so whatever the client sent for one is simply discarded rather than trusted.
      let effectiveAt = null;
      if (decision === "approved" && req.body.effectiveAt) {
        const parsed = parseEffectiveAt(req.body.effectiveAt, Date.now());
        if (!parsed.ok) return res.status(400).json({ error: `effective_date_${parsed.reason}` });
        effectiveAt = parsed.effectiveAt;
      }

      const before = await unbanRequestsRepo.findById(req.body.id);
      if (!before || String(before.channelId) !== String(channel.channelId)) {
        return res.status(404).json({ error: "not_found" });
      }

      const updated = await unbanRequestsRepo.requestDecision(req.body.id, channel.channelId, {
        decision,
        text: req.body.resolutionText,
        user: req.user,
        effectiveAt,
      });
      // The repo refuses to overwrite a decision that's already queued or applied - expected on a
      // double-tap of A/D, or two moderators reaching the same case at once.
      if (!updated) return res.status(409).json({ error: "already_decided" });

      // The verdict is what ends the chat vote now, so tell the bot to close it (it has to be the
      // bot: closing announces the tally in chat). Fire-and-forget relative to the response - a
      // vote left open is cosmetic, and the bot's endsAt ceiling closes it regardless.
      await unbanRequestsRepo.requestVoteClose(req.body.id, channel.channelId);

      await settingsChangeLogRepo.logChange({
        channelLogin: channel.channelLogin,
        user: req.user,
        category: "unban_request",
        action: decision === "approved" ? "approve" : "deny",
        target: before.userLogin,
        before: { twitchStatus: before.twitchStatus },
        after: {
          decision,
          resolutionText: updated.resolution.text,
          effectiveAt: updated.resolution.effectiveAt,
        },
      });

      res.json({ ok: true, resolution: updated.resolution });
    } catch (err) {
      next(err);
    }
  }
);

// Asks the bot to run an advisory chat vote on this case.
router.post(
  "/:channel/unban-bureau/vote.json",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;
      if (!(await requireShiftJson(req, res))) return;

      const before = await unbanRequestsRepo.findById(req.body.id);
      if (!before || String(before.channelId) !== String(channel.channelId)) {
        return res.status(404).json({ error: "not_found" });
      }

      const updated = await unbanRequestsRepo.requestVote(req.body.id, channel.channelId);
      if (!updated) return res.status(409).json({ error: "vote_already_running" });

      // Deliberately NOT written to SettingsChangeLog. Only a VERDICT belongs in that journal -
      // starting an advisory vote is part of reviewing a case, changes nothing on its own, and is
      // reversible by simply deciding. Since a vote opens for practically every case that reaches
      // the desk, logging it doubled the journal's volume with a row that carries no accountability
      // the verdict row (same moderator, same applicant, minutes later) doesn't already carry.
      res.json({ ok: true, vote: updated.vote });
    } catch (err) {
      next(err);
    }
  }
);

// Fires the "stray bullet". Records a request; TwitchBot's scheduler picks the target and calls
// Twitch within ~2s. The page cannot name a victim - see db/sniperShotsRepo.js.
router.post(
  "/:channel/unban-bureau/sniper.json",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;
      if (!(await requireShiftJson(req, res))) return;

      // A second, tighter ceiling on top of settingsWriteLimiter. Every other write on this site
      // edits a setting; this one times a real viewer out of chat, so "10 a minute" is not a
      // reasonable ceiling for it even though it is for the rest.
      const recent = await sniperShotsRepo.countRecentByUser(req.user.userId, SNIPER_WINDOW_MS);
      if (recent >= SNIPER_MAX_PER_WINDOW) {
        return res.status(429).json({ error: "too_many_shots" });
      }

      const shot = await sniperShotsRepo.requestShot(channel, req.user, req.body.id || null);

      // Deliberately NOT written to SettingsChangeLog (was, until 2026-08-09) - see
      // db/sniperShotsRepo.js for the shot record itself, which is the audit trail now.
      res.json({ ok: true, shotId: String(shot._id) });
    } catch (err) {
      next(err);
    }
  }
);

// Fills the desk's fourth sheet: runs the two-turn hearing and stores the result.
//
// THE ONLY ENDPOINT ON THIS SITE THAT SPENDS MONEY. Everything else here writes a document; this
// one buys two speeches from Anthropic (~2 cents, lib/unbanOpinionsGenerator.js). Three guards
// stack, and the middle one is the load-bearing one:
//   - opinionsGenerateLimiter, per user, exempting nobody - the backstop against a runaway loop.
//   - a case that already has a sheet is refused. This is what actually bounds the spend: the
//     button exists to fill a BLANK sheet, so the ceiling is the number of queued appeals, not the
//     number of times someone can click. It also protects the record - a regeneration would
//     silently replace a sheet a moderator may already have read and decided from.
//   - no key configured answers 503 rather than 500, so the page can say the feature is off
//     instead of showing a crash for an optional add-on.
//
// Deliberately NOT written to SettingsChangeLog, for the same reason starting a chat vote isn't:
// the sheet is commentary, not moderation state, and the verdict row already carries the
// accountability. The stored document's own `generatedAt`/`model` are its provenance.
router.post(
  "/:channel/unban-bureau/opinions.json",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;
      if (!(await requireShiftJson(req, res))) return;

      if (!env.anthropicApiKey) {
        return res.status(503).json({ error: "generation_unavailable" });
      }
      if (!opinionsGenerateLimiter(req.user.userId)) {
        return res.status(429).json({ error: "too_many_generations" });
      }

      const unbanCase = await unbanRequestsRepo.findById(req.body.id);
      if (!unbanCase || String(unbanCase.channelId) !== String(channel.channelId)) {
        return res.status(404).json({ error: "not_found" });
      }

      const existing = await unbanOpinionsRepo.findByCaseId(String(unbanCase._id));
      if (existing) return res.status(409).json({ error: "already_generated" });

      const brief = await unbanDossierRepo.getCaseBrief(channel.channelLogin, unbanCase);

      let generated;
      try {
        generated = await generateOpinions({ client: getAnthropicClient(), brief });
      } catch (err) {
        if (err instanceof OpinionsGenerationError) {
          // 502: the failure is upstream of us and the moderator can simply press again. The
          // reason travels so the page can distinguish "try again" from "this won't work".
          console.warn(`[opinions] generation failed for ${unbanCase._id}: ${err.reason} - ${err.message}`);
          return res.status(502).json({ error: "generation_failed", reason: err.reason });
        }
        throw err;
      }

      // Through the same validator the admin API's PUT uses, rather than trusting our own
      // generator's output: `final` and `decision` are derived there, the length cap lives there,
      // and a model that ran long must be rejected by the same rule regardless of who called it.
      const parsed = parseOpinions(generated);
      if (!parsed.ok) {
        console.warn(`[opinions] generated text rejected for ${unbanCase._id}: ${parsed.reason}`);
        return res.status(502).json({ error: "generation_failed", reason: parsed.reason });
      }

      const doc = await unbanOpinionsRepo.upsertOpinions(
        String(unbanCase._id),
        { channelId: channel.channelId, channelLogin: channel.channelLogin },
        parsed.value
      );

      res.json({ ok: true, opinions: doc });
    } catch (err) {
      next(err);
    }
  }
);

// Polled by the page for the moving vote bar and for "has the bot applied my decision yet".
router.get(
  "/:channel/unban-bureau/live.json",
  statsReadLimiter,
  requireLevelJson(2),
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;

      const ids = String(req.query.ids || "").split(",").filter(Boolean).slice(0, 50);
      const [states, shot] = await Promise.all([
        unbanRequestsRepo.getLiveState(channel.channelId, ids),
        // Channel-level, not per case: a shot is fired whenever the moderator feels like it and is
        // not tied to an appeal. See db/sniperShotsRepo.js's findLatestResolved for why this reads
        // SniperShots rather than the `sniper` sub-document this used to project.
        sniperShotsRepo.findLatestResolved(channel.channelId, SNIPER_REPORT_WINDOW_MS),
      ]);
      res.json({
        ok: true,
        states: states.map((doc) => ({
          id: String(doc._id),
          twitchStatus: doc.twitchStatus,
          vote: doc.vote,
          resolution: doc.resolution,
        })),
        // Only what the desk announces - never who requested it, which the page has no use for.
        sniper: shot
          ? {
            id: String(shot._id),
            status: shot.status,
            targetLogin: shot.targetLogin || null,
            mode: shot.mode || null,
            durationSec: shot.durationSec || null,
            failureReason: shot.failureReason || null,
          }
          : null,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
