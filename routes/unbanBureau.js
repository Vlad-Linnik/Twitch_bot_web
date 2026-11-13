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
const crypto = require("crypto");
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const unbanRequestsRepo = require("../db/unbanRequestsRepo");
const unbanDossierRepo = require("../db/unbanDossierRepo");
const unbanBureauShiftRepo = require("../db/unbanBureauShiftRepo");
const unbanOpinionsRepo = require("../db/unbanOpinionsRepo");
const sniperShotsRepo = require("../db/sniperShotsRepo");
const bureauChatRepo = require("../db/bureauChatRepo");
const unbanBureauValidation = require("../lib/unbanBureauValidation");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const emoteImages = require("../twitch/emoteImages");
const { parseEffectiveAt } = require("../lib/unbanDecisionValidation");
const { parseLogCursor } = require("../lib/unbanLogPaging");
const { toSheet } = require("../lib/unbanOpinionsValidation");
const {
  generateSummary,
  buildWriters,
  OpinionsGenerationError,
} = require("../lib/unbanOpinionsGenerator");
const {
  createSummaryBatches,
  selectCasesForSummary,
  DEFAULT_PACE_MS,
} = require("../lib/unbanSummaryBatch");
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

// Which vendors this deployment can write a summary with. The ORDER is the generator's business,
// not this route's - all that is decided here is which keys exist, and an empty list is what
// becomes the 503 below. Rebuilt per press because it is two object literals, and pinning it in a
// module variable would only cache the answer to "was the key set at boot".
function summaryWriters() {
  return buildWriters({
    google: env.geminiApiKey ? { apiKey: env.geminiApiKey } : null,
    anthropic: env.anthropicApiKey ? getAnthropicClient() : null,
  });
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
// Fallback for a channel whose stored config predates the grenade. Kept equal to
// lib/unbanBureauValidation.js's DEFAULTS.grenadeCooldownSec; the floor there is what the value is
// clamped to on save, and this only stands in until the channel saves its settings once.
const GRENADE_DEFAULT_COOLDOWN_SEC = unbanBureauValidation.DEFAULTS.grenadeCooldownSec;

const router = express.Router();

// The "ИИ-обзор для всех" jobs, one per channel, for the life of this process. See
// lib/unbanSummaryBatch.js.
const summaryBatches = createSummaryBatches();

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

// The page-load token the desk page was handed, echoed back on its heartbeat and its hand-back.
// Client-supplied and therefore never trusted for authorisation - it only ever narrows a delete
// that is already scoped to this user's own lease, so the worst a forged one can do is fail to
// release a shift the moderator already holds. Bounded and type-checked so a junk body can't reach
// Mongo as an object.
function shiftTokenOf(req) {
  const token = req.body?.shiftToken;
  return typeof token === "string" && token.length && token.length <= 100 ? token : null;
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

    // Identifies THIS page load at the desk, not the moderator - see the repo's release(). Minted
    // server-side because the claim happens here, before any client script has run.
    const shiftToken = crypto.randomUUID();

    // Claiming the desk comes before the (much heavier) queue read: a moderator who is being turned
    // away has no use for the cases, and shouldn't pay for assembling them.
    const shift = await unbanBureauShiftRepo.acquire(channel.channelLogin, req.user, {
      token: shiftToken,
    });
    if (!shift.ok) {
      // permissionLevel comes from requireLevel(2) above; the busy page uses it to decide whether
      // to offer the takeover button, which is owner/admin-only (see the takeover route).
      return res.status(409).render("unbanBureauBusy", {
        channel,
        holder: shift.holder,
        canTakeOver: req.permissionLevel <= 1,
      });
    }

    const newestFirst = req.query.sort !== "oldest";
    const cases = await unbanRequestsRepo.listPendingForChannel(channel.channelId, { newestFirst });

    // Nothing to hold the desk for, and the empty state runs no client script - so there'd be
    // nothing renewing the lease either. Give it straight back rather than locking the channel out
    // for a lease's length because someone glanced at an empty queue.
    if (!cases.length) {
      await unbanBureauShiftRepo.release(channel.channelLogin, req.user.userId, shiftToken);
    }

    // Same channel-wide name -> image map the emote cloud and the news comments box resolve
    // against (twitch/emoteImages.js) - so an emote name typed in an appeal or said in chat
    // renders as the actual emote in the log/appeal panes, not its text signature.
    const emoteMap = cases.length
      ? await emoteImages.getEmoteImageMap(channel.channelId, channel.channelLogin).catch(() => new Map())
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
      shiftToken,
    });
  } catch (err) {
    next(err);
  }
});

// The dossier for one case, fetched lazily as the moderator moves between cases (and again with
// ?before= / ?after= as they scroll the chat log towards older or newer lines).
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

      // `before` / `after` walk the chat log one page older / newer (lib/unbanLogPaging.js). Either
      // one makes this a paging request: the same case still open, wanting only more log.
      const before = req.query.before || null;
      const after = req.query.after || null;
      const paging = Boolean(before || after);
      if (paging && !parseLogCursor({ before, after }).ok) {
        return res.status(400).json({ error: "bad_cursor" });
      }

      const dossier = await unbanDossierRepo.getDossier(channel.channelLogin, unbanCase, { before, after });

      // Opening a case is what makes the bot read Twitch's viewer card for it (see
      // unbanRequestsRepo.requestViewerCard). Skipped when paging the log - a scroll-back is the
      // same case still open, and the request is already in flight or long since served.
      //
      // `preparing` is only true when we hold NO mirror at all, and it drives the "Подготовка дела"
      // screen rather than a spinner over live numbers. A case that has a mirror renders straight
      // away even if the bot is about to refresh it: those are real Twitch figures, just minutes
      // old, and blanking the card to re-fetch what is already correct would be theatre. What the
      // screen prevents is the opposite and much worse case - painting the bot's own much smaller
      // counts, which a moderator may read and act on, and then silently swapping them for Twitch's
      // two seconds later.
      let preparing = false;
      if (!paging) {
        preparing = !unbanCase.twitchModLogs;
        unbanRequestsRepo
          .requestViewerCard(String(unbanCase._id), channel.channelId)
          .catch((err) => console.error("[unban-bureau] viewer-card request failed:", err));
      }

      // The fourth sheet rides along here rather than in the page's `data-cases`
      // attribute, for the reason unbanRequestsRepo.listPendingForChannel projects twitchModLogs
      // out: everything embedded in that attribute is paid for by every case in the queue on every
      // page load, and a few paragraphs per case is exactly the kind of thing that grew one
      // channel's markup from 1KB to 25KB last time. Most cases have no opinions at all.
      //
      // Skipped when paging the log (?before= / ?after=): that request only wants more chat lines,
      // and re-sending an unchanged sheet with each page is pure waste.
      // Normalized on the way out, never on the way in: a summary arrives as one, an old
      // prosecutor/advocate hearing (either stored shape) as a transcript, so the page has exactly
      // two kinds to render and never guesses. See lib/unbanOpinionsValidation.js's toSheet.
      const opinions = paging
        ? undefined
        : toSheet(await unbanOpinionsRepo.findByCaseId(String(unbanCase._id)));

      res.json({
        ok: true,
        dossier,
        preparing,
        ...(opinions === undefined ? {} : { opinions: opinions || null }),
      });
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

      const shift = await unbanBureauShiftRepo.acquire(channel.channelLogin, req.user, {
        token: shiftTokenOf(req),
      });
      // Renewal and re-acquisition are the same call, so a moderator whose lease lapsed while the
      // tab was backgrounded simply takes the desk back if nobody else has claimed it.
      if (!shift.ok) return res.status(409).json({ error: "shift_taken", holder: shift.holder });
      res.json({ ok: true, holder: shift.holder });
    } catch (err) {
      next(err);
    }
  }
);

// Ejects whoever is at the desk and takes it. The escape hatch for an abandoned tab that is still
// renewing its lease - the client now hands the desk back on its own when the tab is hidden
// (public/js/games/unban-bureau.js), but that only helps a page running the current build, and it
// cannot help a machine left awake with the Bureau on screen.
//
// requireLevel(1), NOT the tier-2 gate the rest of this router uses: letting moderators eject each
// other would undo the single-occupancy rule this whole lease exists to enforce. Owner and site
// admin only.
//
// A plain form POST with a redirect rather than the JSON convention above - the busy page is an
// ordinary page, this is a once-in-a-while action, and the redirect lands the moderator straight at
// the desk it just freed.
router.post(
  "/:channel/unban-bureau/takeover",
  settingsWriteLimiter,
  requireLevel(1),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;

      const { previous } = await unbanBureauShiftRepo.forceAcquire(channel.channelLogin, req.user);

      // Unlike starting a vote (dropped from this journal as a duplicate of the vote record), an
      // eviction has no other record anywhere and it is taken against a named colleague. Skipped
      // when there was nobody to evict - the lease had already lapsed, so nothing was taken from
      // anyone.
      if (previous && previous.userId !== String(req.user.userId)) {
        await settingsChangeLogRepo.logChange({
          channelLogin: channel.channelLogin,
          user: req.user,
          category: "unban_request",
          action: "takeover",
          target: previous.login,
          before: { holder: previous.login, startedAt: previous.startedAt },
          after: { holder: req.user.login },
        });
      }

      res.redirect(`/${channel.channelLogin}/unban-bureau`);
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
      await unbanBureauShiftRepo.release(channel.channelLogin, req.user.userId, shiftTokenOf(req));
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

// Journals a trigger pull. `SniperShots` already records the shot itself, but that collection has
// no page anywhere and lives in the bot's database, so the only place a channel owner reads what
// happened on their desk - next to the verdicts, in the same journal - never mentioned the two
// things here that punish a viewer who never appealed anything.
//
// No target: the page cannot name one and the bot draws it a couple of seconds later, into a
// database this journal (web-only, see db/settingsChangeLogRepo.js) cannot be joined against. So a
// row states who fired and when, and the outcome stays in `SniperShots` and in Twitch's own
// moderation log. Repeat pulls collapse onto one row with a tally - BURST_ACTIONS there.
//
// Called only after the write it describes has been accepted: a shot refused by the per-moderator
// ceiling or a grenade refused by the channel cooldown never happened.
async function logWeapon(channel, user, action) {
  await settingsChangeLogRepo.logChange({
    channelLogin: channel.channelLogin,
    user,
    category: "unban_request",
    action,
    target: null,
    before: null,
    after: null,
  });
}

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
      await logWeapon(channel, req.user, "sniper");

      res.json({ ok: true, shotId: String(shot._id) });
    } catch (err) {
      next(err);
    }
  }
);

// Throws the grenade: same execute-only-by-bot contract as the rifle, but it takes EVERYONE who
// spoke in the last 30 seconds instead of one drawn victim.
//
// Which is why this endpoint, unlike sniper.json, is rate-limited per CHANNEL rather than per
// moderator. The rifle's ceiling is a per-moderator budget because one shot is one viewer; a
// grenade is the whole of chat at once, so "six a minute each" would let a two-moderator desk keep
// a channel permanently timed out. The per-moderator budget still applies on top - a grenade
// spends a shot from it too.
//
// The cooldown is enforced here rather than bot-side deliberately: refusing at the moment of the
// click is what lets the desk show the moderator a countdown instead of accepting a throw that
// quietly does nothing two seconds later.
router.post(
  "/:channel/unban-bureau/grenade.json",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;
      if (!(await requireShiftJson(req, res))) return;

      const recent = await sniperShotsRepo.countRecentByUser(req.user.userId, SNIPER_WINDOW_MS);
      if (recent >= SNIPER_MAX_PER_WINDOW) {
        return res.status(429).json({ error: "too_many_shots" });
      }

      const config = await channelConfigRepo.getConfig(channel.channelLogin);
      const cooldownMs =
        (config.unbanBureau?.grenadeCooldownSec || GRENADE_DEFAULT_COOLDOWN_SEC) * 1000;

      const result = await sniperShotsRepo.requestGrenade(
        channel,
        req.user,
        req.body.id || null,
        cooldownMs
      );
      if (result.readyAt) {
        return res.status(429).json({
          error: "grenade_cooldown",
          // Milliseconds rather than a timestamp: the page counts down against its own clock, which
          // is not the server's, and a remaining-time number survives that gap.
          retryAfterMs: Math.max(0, result.readyAt.getTime() - Date.now()),
        });
      }

      await logWeapon(channel, req.user, "grenade");

      res.json({ ok: true, shotId: String(result.shot._id), cooldownMs });
    } catch (err) {
      next(err);
    }
  }
);

// The channel's own log window for the summary (lib/unbanBureauValidation.js's aiLogMessages,
// 0 = the heuristic). Read per call rather than cached: settings saved a minute ago must apply to
// the next summary, and this is one small document next to a model call.
async function summaryLogMessages(channelLogin) {
  const config = await channelConfigRepo.getConfig(channelLogin);
  const value = config.unbanBureau?.aiLogMessages;
  return Number.isInteger(value) && value > 0 ? value : 0;
}

class SummarySkipped extends Error {}

// One case, start to finish: brief, model call, validated write. Shared by the sheet's own button
// and the batch so the two cannot drift - the batch is the same press, repeated.
//
// The "already has a sheet" check is repeated here, right before the call, rather than trusted from
// whoever chose the case: the batch picked its list at start, and a moderator may have pressed the
// sheet's own button on one of those cases since. Throws SummarySkipped for that, and
// OpinionsGenerationError when neither vendor produced a usable summary.
async function writeSummary(channel, unbanCase, writers, logMessages) {
  const caseId = String(unbanCase._id);
  if (await unbanOpinionsRepo.findByCaseId(caseId)) throw new SummarySkipped("already_generated");

  const brief = await unbanDossierRepo.getCaseBrief(channel.channelLogin, unbanCase, { logMessages });
  const generated = await generateSummary({ writers, brief });

  return unbanOpinionsRepo.upsertSummary(
    caseId,
    { channelId: channel.channelId, channelLogin: channel.channelLogin },
    generated.summary,
    { model: generated.model, effort: generated.effort }
  );
}

// Fills the desk's fourth sheet for one case: one model call, one short summary.
//
// ONE OF TWO ENDPOINTS ON THIS SITE THAT CAN SPEND MONEY (the batch below is the other). Free on
// Google, about two cents on the Anthropic fallback (lib/unbanOpinionsGenerator.js). Three guards
// stack, and the middle one is the load-bearing one:
//   - opinionsGenerateLimiter, per user, exempting nobody - the backstop against a runaway loop.
//   - a case that already has a sheet is refused. This is what actually bounds the spend: the
//     button exists to fill a BLANK sheet, so the ceiling is the number of queued appeals, not the
//     number of times someone can click. It also protects the record - a regeneration would
//     silently replace a sheet a moderator may already have read and decided from. That includes a
//     prosecutor/advocate hearing written before the summary existed: it stays as it is.
//   - no key at all - neither vendor - answers 503 rather than 500, so the page can say the
//     feature is off instead of showing a crash for an optional add-on.
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

      const writers = summaryWriters();
      if (!writers.length) {
        return res.status(503).json({ error: "generation_unavailable" });
      }
      if (!opinionsGenerateLimiter(req.user.userId)) {
        return res.status(429).json({ error: "too_many_generations" });
      }

      const unbanCase = await unbanRequestsRepo.findById(req.body.id);
      if (!unbanCase || String(unbanCase.channelId) !== String(channel.channelId)) {
        return res.status(404).json({ error: "not_found" });
      }
      // The batch is writing this very case right now; a second call would pay twice for one sheet.
      if (summaryBatches.isWriting(channel.channelLogin, unbanCase._id)) {
        return res.status(409).json({ error: "already_generating" });
      }

      let doc;
      try {
        doc = await writeSummary(channel, unbanCase, writers, await summaryLogMessages(channel.channelLogin));
      } catch (err) {
        if (err instanceof SummarySkipped) return res.status(409).json({ error: "already_generated" });
        if (err instanceof OpinionsGenerationError) {
          // 502: the failure is upstream of us and the moderator can simply press again. The
          // reason travels so the page can distinguish "try again" from "this won't work".
          // Every vendor in the list has already logged its own failure by now; this line is the
          // one that ties them to a case.
          console.warn(`[opinions] summary failed for ${unbanCase._id}: ${err.reason} - ${err.message}`);
          return res.status(502).json({ error: "generation_failed", reason: err.reason });
        }
        throw err;
      }

      res.json({ ok: true, opinions: toSheet(doc) });
    } catch (err) {
      next(err);
    }
  }
);

// ── "ИИ-обзор для всех" ─────────────────────────────────────────────────────────────────────────
//
// The same summary for every queued case of the channel that has no sheet yet, run server-side one
// case at a time (lib/unbanSummaryBatch.js has the why of the job, its pace and its skip rule).
// Started and watched from the Bureau's SETTINGS page, not the desk: it is a channel-level chore,
// and it does not need - or take - the desk's one-moderator shift. Gated exactly like that page's
// own form: reading at tier 2, writing behind requireSettingsEditAccess + CSRF + the write limiter.
//
// No per-moderator generation limiter here, unlike the sheet's own button: the batch bounds itself
// - one job per channel, a list fixed at start, one call per case per press - and charging thirty
// queued cases against an hourly allowance of thirty would make the button useless on exactly the
// channels it exists for.

// Queued cases with no sheet, newest appeal first - the order the desk itself opens them in, so the
// cases a moderator is most likely to pick up next are the first to be ready.
async function summaryCandidates(channel) {
  const cases = await unbanRequestsRepo.listPendingForChannel(channel.channelId, { newestFirst: true });
  const withSheets = await unbanOpinionsRepo.findCaseIdsWithSheets(cases.map((c) => String(c._id)));
  return selectCasesForSummary(cases, withSheets);
}

router.get(
  "/:channel/unban-bureau/summaries/status.json",
  statsReadLimiter,
  requireLevelJson(2),
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;
      const job = summaryBatches.status(channel.channelLogin);
      const running = Boolean(job && job.status === "running");
      res.json({
        ok: true,
        available: summaryWriters().length > 0,
        // Only Anthropic costs money; without its key a Google failure is simply a failed case.
        paidFallback: Boolean(env.anthropicApiKey),
        paceSec: Math.round(DEFAULT_PACE_MS / 1000),
        // What a press would do right now - the number the confirmation shows. Not computed while a
        // job runs: the page is showing that job's own total then, and this poll fires every few
        // seconds.
        eligible: running ? null : (await summaryCandidates(channel)).length,
        job,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:channel/unban-bureau/summaries/start.json",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;

      const writers = summaryWriters();
      if (!writers.length) return res.status(503).json({ error: "generation_unavailable" });

      // Fixed for the whole job, like the case list: a window changed mid-run would leave half the
      // queue summarised from one depth of log and half from another.
      const logMessages = await summaryLogMessages(channel.channelLogin);

      const started = await summaryBatches.start(channel.channelLogin, {
        startedBy: req.user.login || null,
        listCandidates: () => summaryCandidates(channel),
        runCase: async (candidate) => {
          const unbanCase = await unbanRequestsRepo.findById(candidate.id);
          // Stamped here, or withdrawn or resolved at Twitch, since the list was read: nothing to
          // summarise. The same two conditions listPendingForChannel() filters on.
          if (
            !unbanCase ||
            String(unbanCase.channelId) !== String(channel.channelId) ||
            unbanCase.twitchStatus !== "pending" ||
            unbanCase.resolution?.status === "pending"
          ) {
            return "skipped";
          }
          try {
            await writeSummary(channel, unbanCase, writers, logMessages);
          } catch (err) {
            if (err instanceof SummarySkipped) return "skipped";
            throw err;
          }
          return "done";
        },
      });

      if (!started.ok) {
        const status = started.reason === "already_running" ? 409 : 400;
        return res.status(status).json({ error: started.reason, job: started.job || null });
      }
      res.json({ ok: true, job: started.job });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:channel/unban-bureau/summaries/stop.json",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;
      const stopped = summaryBatches.stop(channel.channelLogin);
      if (!stopped.ok) return res.status(409).json({ error: stopped.reason, job: stopped.job });
      res.json({ ok: true, job: stopped.job });
    } catch (err) {
      next(err);
    }
  }
);

// Polled by the page for the moving vote bar, for "has the bot applied my decision yet", and for
// the chat lines the street's crowd says (db/bureauChatRepo.js).
router.get(
  "/:channel/unban-bureau/live.json",
  statsReadLimiter,
  requireLevelJson(2),
  async (req, res, next) => {
    try {
      const channel = await loadChannelJson(req, res);
      if (!channel) return;

      const ids = String(req.query.ids || "").split(",").filter(Boolean).slice(0, 50);
      const config = await channelConfigRepo.getConfig(channel.channelLogin);
      const cooldownMs =
        (config.unbanBureau?.grenadeCooldownSec || GRENADE_DEFAULT_COOLDOWN_SEC) * 1000;
      const [states, shot, grenadeReadyAt, chat] = await Promise.all([
        unbanRequestsRepo.getLiveState(channel.channelId, ids),
        // Channel-level, not per case: a shot is fired whenever the moderator feels like it and is
        // not tied to an appeal. See db/sniperShotsRepo.js's findLatestResolved for why this reads
        // SniperShots rather than the `sniper` sub-document this used to project.
        sniperShotsRepo.findLatestResolved(channel.channelId, SNIPER_REPORT_WINDOW_MS),
        // So the desk can grey the grenade out for a moderator who has just opened the page, rather
        // than only after they have thrown one and been refused.
        sniperShotsRepo.grenadeReadyAt(channel.channelId, cooldownMs),
        // The street's speech bubbles and flying vote emotes. Decoration: a failed read is an empty
        // street for one poll, never a failed poll - the vote bar and the decision status ride on
        // this same response.
        bureauChatRepo
          .readChatSince(channel.channelLogin, req.query.chatAfter)
          .catch(() => ({ lines: [], cursor: null })),
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
            // Absent on every row written before the grenade existed, and those are all rifle
            // shots - see db/sniperShotsRepo.js.
            weapon: shot.weapon === "grenade" ? "grenade" : "awp",
            status: shot.status,
            targetLogin: shot.targetLogin || null,
            targetLogins: shot.targetLogins || null,
            targetCount: shot.targetCount ?? null,
            hitCount: shot.hitCount ?? null,
            mode: shot.mode || null,
            durationSec: shot.durationSec || null,
            failureReason: shot.failureReason || null,
          }
          : null,
        chat: chat.lines,
        // Echoed back as ?chatAfter= on the next poll; null means "keep the one you have".
        chatCursor: chat.cursor,
        grenadeRetryAfterMs: grenadeReadyAt
          ? Math.max(0, grenadeReadyAt.getTime() - Date.now())
          : 0,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
