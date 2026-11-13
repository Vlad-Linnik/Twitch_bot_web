// /:channel/movies - what the channel has watched on stream: a grid of cards, each with the
// streamer's score and review, the viewers' average, hearts and a discussion. Off by default per
// channel (Channels.moviesEnabled, switched by the site admin); a tier-0 admin previews it before
// that, as with news.
//
// Who does what:
//   - creating, editing, deleting a card: levels 0-2, through requireSectionEditAccess - a
//     moderator the owner has not allowed to change "discussions" (lib/moderatorSections.js) is
//     barred here, as from comment moderation;
//   - the review and the streamer's score: the owner, or the site admin writing on the owner's
//     behalf (the signature is always the streamer's - the point is to carry over reviews the
//     streamer already wrote elsewhere);
//   - a viewer's score, hearts, comments: anyone logged in; the score only on a watched card, never
//     by the owner (they have their own), and only counted in the average for someone who has
//     chatted in the channel (db/chatPresenceRepo.js).
//
// Writes by the owner or a moderator go to the channel's SettingsChangeLog (category "media");
// the admin's go to AdminActionLogs, like every other admin action.
//
// The grid pages by cursor (lib/cursorPaging.js's in-memory variant): a sort by a rating cannot be
// served by Mongo (the viewer average is computed on read), and a channel has hundreds of cards,
// not tens of thousands. 24 per portion - a full last row at 2, 3, 4 and 6 columns.
const express = require("express");
const multer = require("multer");
const mediaItemsRepo = require("../db/mediaItemsRepo");
const mediaRatingsRepo = require("../db/mediaRatingsRepo");
const mediaThreads = require("../db/mediaThreads");
const chatPresenceRepo = require("../db/chatPresenceRepo");
const adminActionLogsRepo = require("../db/adminActionLogsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const requireLogin = require("../middleware/requireLogin");
const { verifyToken } = require("../middleware/csrf");
const { requireSectionEditAccess, canEditSectionAt } = require("../middleware/permissions");
const { loadChannelSection } = require("../middleware/channelSection");
const { createSimpleLimiter, settingsWriteLimiter } = require("../middleware/rateLimiters");
const cursorPaging = require("../lib/cursorPaging");
const { buildChannelNav } = require("../lib/channelNav");
const { COMMENT_SORT_MODES } = require("../lib/commentValidation");
const media = require("../lib/mediaValidation");
const { savePoster, deletePoster, gridPosterUrl } = require("../lib/mediaImage");
const { createMediaSources } = require("../lib/mediaSources");
const { fetchAllowedImage } = require("../lib/remoteImage");
const { isAllowedMediaImageUrl } = require("../lib/mediaImageHosts");
const env = require("../config/env");
const { createDiscussionRoutes } = require("./discussionRoutes");

const router = express.Router();

const SECTION = "movies";
// The moderator right that covers this section's cards (lib/moderatorSections.js).
const EDIT_SECTION = "discussions";
const KIND = "movie";
const ITEMS_PER_PORTION = 24;
// "Back" restore ceiling, as on the news feed.
const RESTORE_MAX = 240;
const POSTER_MAX_BYTES = 5 * 1024 * 1024;
const REACTION_TYPES = ["like", "superlike"];
// The two grid tabs. "Planned" becomes part of the suggestions tab once viewers can suggest.
const TABS = { done: "done", planned: "accepted" };

const page = loadChannelSection(SECTION);
const pageJson = loadChannelSection(SECTION, { json: true });
const write = loadChannelSection(SECTION, { allowPreview: false });
const writeJson = loadChannelSection(SECTION, { json: true, allowPreview: false });
// Editors work in preview too: the admin fills the section before switching it on. Checked before
// multer reads the body, so an anonymous request never gets a 5 MB upload buffered.
const edit = [requireSectionEditAccess(EDIT_SECTION), loadChannelSection(SECTION)];
const editJson = [requireSectionEditAccess(EDIT_SECTION), loadChannelSection(SECTION, { json: true })];

// The search behind the card form (TMDB / Shikimori / the no-key IMDb fallback), one instance and
// one cache for the process.
const mediaSources = createMediaSources({ tmdbToken: env.tmdbReadToken });

const discussion = createDiscussionRoutes({
  section: SECTION,
  store: mediaThreads,
  getItem: async (id) => {
    const item = await mediaItemsRepo.getById(id);
    return item && item.kind === KIND ? item : null;
  },
  adminActionPrefix: "mediaComment",
});

const reactLimiterAllow = createSimpleLimiter({ windowMs: 8 * 1000, max: 8 });
const rateLimiterAllow = createSimpleLimiter({ windowMs: 60 * 1000, max: 20 });
// The search box fires on typing (debounced client-side); this only stops a script.
const lookupLimiterAllow = createSimpleLimiter({ windowMs: 60 * 1000, max: 60 });

const posterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: POSTER_MAX_BYTES },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("image/")),
});

// A bad upload (too big, wrong field) becomes a form error instead of the 500 page.
function uploadPoster(req, res, next) {
  posterUpload.single("poster")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      req.posterUploadError = true;
      return next();
    }
    next(err);
  });
}

const wantsJson = (req) => (req.get("accept") || "").includes("application/json");

// requireSectionEditAccess's rule, answered without rejecting - for drawing the buttons.
function canEdit(req) {
  return canEditSectionAt(req.permission, req.channel.channelId, req.user?.userId, EDIT_SECTION);
}

// The review and the streamer's score: the owner, or the admin on the owner's behalf.
const canWriteStreamerFields = (permission) => permission <= 1;

async function loadCard(req) {
  const item = await mediaItemsRepo.getById(req.params.id);
  return item && item.kind === KIND && item.channelLogin === req.channel.channelLogin ? item : null;
}

async function logWrite(req, action, item) {
  if (req.permission === 0) {
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: `media.${action}`,
      target: `${req.channel.channelLogin}:${item._id}`,
      details: item.title,
    });
    return;
  }
  await settingsChangeLogRepo.logChange({
    channelLogin: req.channel.channelLogin,
    user: req.user,
    category: "media",
    action,
    target: item.title,
    before: null,
    after: null,
  });
}

// --- grid -------------------------------------------------------------------------------

function readGridQuery(query) {
  const tab = Object.prototype.hasOwnProperty.call(TABS, query.tab) ? query.tab : "done";
  const sort = media.resolveSort(query.sort);
  const q = typeof query.q === "string" ? query.q.slice(0, 100) : "";
  return { tab, sort, q };
}

// The whole filtered, sorted list for one grid view; portions are sliced from it.
async function gridRows(channel, { tab, sort, q }) {
  const rows = await mediaItemsRepo.listForGrid(channel.channelLogin, KIND, TABS[tab]);
  const spec = media.SORTS[sort];
  return rows
    .filter((r) => media.matchesSearch(r.searchKey, q))
    .map(media.withSortKeys)
    .sort(cursorPaging.compareBySpec(spec));
}

function shapeCard(item) {
  return {
    id: String(item._id),
    title: item.title,
    originalTitle: item.originalTitle,
    year: item.year,
    mediaType: item.mediaType,
    status: item.status,
    nsfw: item.nsfw,
    posterUrl: gridPosterUrl(item),
    progress: media.progressBadge(item.progress),
    streamerRating: item.ratings?.streamer ?? null,
    viewerAverage: media.viewerAverage(item.ratings?.viewers),
    imdbRating: item.ratings?.external?.source === "imdb" ? item.ratings.external.value : null,
    excerpt: item.review?.excerpt || null,
    commentCount: item.commentCount || 0,
    likeCount: item.likeCount || 0,
  };
}

function gridUrl(channel, { tab, sort, q }, extra = {}) {
  const params = new URLSearchParams();
  if (tab !== "done") params.set("tab", tab);
  if (sort !== media.DEFAULT_SORT) params.set("sort", sort);
  if (q) params.set("q", q);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const qs = params.toString();
  return `/${channel.channelLogin}/${SECTION}${qs ? `?${qs}` : ""}`;
}

router.get(`/:channel/${SECTION}`, page, async (req, res, next) => {
  try {
    const { channel, permission } = req;
    const view = readGridQuery(req.query);
    const spec = media.SORTS[view.sort];
    const parsed = cursorPaging.parseCursor(spec, req.query.cursor);
    if (parsed.error) return res.status(400).render("errors/400", { backHref: gridUrl(channel, view) });

    const [rows, counts, broadcaster, editor] = await Promise.all([
      gridRows(channel, view),
      mediaItemsRepo.countByStatus(channel.channelLogin, KIND),
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
      req.user ? canEdit(req) : Promise.resolve(false),
    ]);
    const { items, nextCursor } = cursorPaging.pageSorted(spec, rows, parsed.cursor, ITEMS_PER_PORTION);

    res.render("movies", {
      channel,
      broadcaster,
      channelNav: buildChannelNav(channel, { permission, active: SECTION }),
      cards: items.map(shapeCard),
      view,
      sorts: Object.keys(media.SORTS),
      tabs: Object.keys(TABS).map((key) => ({ key, count: counts[TABS[key]] || 0, href: gridUrl(channel, { ...view, tab: key }) })),
      nextHref: nextCursor ? gridUrl(channel, view, { cursor: nextCursor }) : null,
      listSrc: `/${channel.channelLogin}/${SECTION}/list.json?${new URLSearchParams({ tab: view.tab, sort: view.sort, q: view.q })}`,
      restoreKey: parsed.cursor ? null : `movies:${channel.channelLogin}:${view.tab}:${view.sort}:${view.q}`,
      totalShown: rows.length,
      canEdit: editor,
      sectionPreview: res.locals.sectionPreview,
    });
  } catch (err) {
    next(err);
  }
});

// Static tails before /:id, or "list.json" and "new" would be read as card ids.
router.get(`/:channel/${SECTION}/list.json`, pageJson, async (req, res, next) => {
  try {
    const { channel } = req;
    const view = readGridQuery(req.query);
    const spec = media.SORTS[view.sort];
    const rows = await gridRows(channel, view);

    let portion;
    let restored = false;
    if (req.query.through !== undefined) {
      const index = rows.findIndex((r) => String(r._id) === String(req.query.through));
      if (index === -1 || index >= RESTORE_MAX) return res.json({ ok: true, restored: false });
      // Down to the card and one portion past it, so the page is long enough to scroll it back
      // to where it sat on screen.
      const end = index + 1 + ITEMS_PER_PORTION;
      const slice = rows.slice(0, end + 1);
      portion = cursorPaging.slicePortion(spec, slice, end);
      restored = true;
    } else {
      const parsed = cursorPaging.parseCursor(spec, req.query.cursor);
      if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
      portion = cursorPaging.pageSorted(spec, rows, parsed.cursor, ITEMS_PER_PORTION);
    }

    res.render("partials/mediaCards", { cards: portion.items.map(shapeCard), channel, section: SECTION }, (err, html) => {
      if (err) return next(err);
      res.json({ ok: true, html, nextCursor: portion.nextCursor, restored });
    });
  } catch (err) {
    next(err);
  }
});

// --- search in outside sources (the editor's autofill) ----------------------------------
// ?tab=films|anime&q=...  -> {results: [{ref, title, originalTitle, year, mediaType, previewUrl}]}
// ?ref=tmdb:movie:27205   -> {details: {..., imdbId, episodes, posterUrl, nsfwHint}}
// Editors only: it spends other services' quotas on the site's behalf. Declared before /:id.
router.get(`/:channel/${SECTION}/lookup.json`, editJson, async (req, res, next) => {
  try {
    if (!lookupLimiterAllow(req.user.userId)) return res.status(429).json({ ok: false, error: "rate_limited" });
    if (typeof req.query.ref === "string") {
      const details = await mediaSources.details(req.query.ref);
      return res.json({ ok: true, details });
    }
    const tab = typeof req.query.tab === "string" ? req.query.tab : "films";
    const { results, source, unavailable } = await mediaSources.search(tab, req.query.q);
    res.json({ ok: true, source: source || null, results, unavailable: Boolean(unavailable) });
  } catch (err) {
    next(err);
  }
});

// --- create / edit / delete ------------------------------------------------------------

function formModel(req, { item = null, values = null, errors = [] } = {}) {
  const src = values || (item
    ? {
        title: item.title,
        originalTitle: item.originalTitle || "",
        year: item.year ?? "",
        mediaType: item.mediaType,
        status: item.status,
        imdbId: item.external?.imdbId || "",
        nsfw: item.nsfw,
        recordingUrl: item.recordingUrl || "",
        progressDone: item.progress?.done ?? "",
        progressTotal: item.progress?.unit === "episode" ? item.progress.total ?? "" : "",
        streamerRating: item.ratings?.streamer ?? "",
        review: item.review?.bodyRaw || "",
      }
    : { mediaType: "film", status: "done" });
  return {
    channel: req.channel,
    item,
    values: src,
    errors,
    mediaTypes: media.MEDIA_TYPES,
    statuses: media.EDITOR_STATUSES,
    canWriteStreamerFields: canWriteStreamerFields(req.permission),
    posterUrl: item?.poster?.url || null,
    lookupSources: mediaSources.describe(),
    lookupUrl: `/${req.channel.channelLogin}/${SECTION}/lookup.json`,
  };
}

router.get(`/:channel/${SECTION}/new`, edit, (req, res) => {
  res.render("mediaForm", formModel(req));
});

// Shared by create and edit: parse, validate, store the poster. Returns {errors} or {value, poster}.
//
// A result picked in the search box arrives as `sourceRef` only. Its details - the source's own
// ids and the poster URL - are asked for again here, by the server, and only that answer is used:
// a poster URL is never read from the form, or the form would be a way to make our server fetch
// any address. An uploaded file wins over the source's poster. A poster that fails to download
// does not block the save; the card is stored without one and can get it later.
async function readForm(req) {
  const { errors, value } = media.parseMediaForm(req.body, { canWriteStreamerFields: canWriteStreamerFields(req.permission) });
  if (req.posterUploadError) errors.push("poster_invalid");

  let picked = null;
  if (typeof req.body.sourceRef === "string" && req.body.sourceRef) {
    picked = await mediaSources.details(req.body.sourceRef);
    if (!picked) errors.push("source_unavailable");
  }

  let poster = null;
  if (errors.length === 0 && req.file) {
    try {
      poster = await savePoster(req.file.buffer);
    } catch {
      errors.push("poster_invalid");
    }
  } else if (errors.length === 0 && picked?.posterUrl) {
    try {
      const buffer = await fetchAllowedImage(picked.posterUrl, { isAllowed: isAllowedMediaImageUrl });
      poster = await savePoster(buffer, { source: picked.source });
    } catch (err) {
      console.warn(`[movies] poster from ${picked.source} not saved: ${err.code || err.message}`);
    }
  }
  return { errors, value, poster, picked };
}

// The card's `external` ids: the IMDb id from the form (typed, or filled from the pick), the
// search source's own id only from the server-side details.
function externalIds(value, picked) {
  const external = {};
  if (value.imdbId) external.imdbId = value.imdbId;
  if (picked?.external?.tmdbId) Object.assign(external, { tmdbId: picked.external.tmdbId, tmdbType: picked.external.tmdbType });
  if (picked?.external?.shikimoriId) external.shikimoriId = picked.external.shikimoriId;
  return external;
}

const isDuplicate = (err) => err && err.code === 11000;

router.post(`/:channel/${SECTION}`, edit, settingsWriteLimiter, uploadPoster, verifyToken, async (req, res, next) => {
  try {
    const { errors, value, poster, picked } = await readForm(req);
    if (errors.length) return res.status(400).render("mediaForm", formModel(req, { values: req.body, errors }));

    let item;
    try {
      item = await mediaItemsRepo.create({
        channelLogin: req.channel.channelLogin,
        kind: KIND,
        ...value,
        external: externalIds(value, picked),
        poster,
        review: value.review ? { ...value.review, authorUserId: req.user.userId, updatedAt: new Date() } : null,
        createdBy: { userId: req.user.userId, login: req.user.login, level: req.permission },
      });
    } catch (err) {
      await deletePoster(poster);
      if (isDuplicate(err)) return res.status(400).render("mediaForm", formModel(req, { values: req.body, errors: ["duplicate"] }));
      throw err;
    }
    await logWrite(req, "create", item);
    res.redirect(`/${req.channel.channelLogin}/${SECTION}/${item._id}`);
  } catch (err) {
    next(err);
  }
});

router.get(`/:channel/${SECTION}/:id/edit`, edit, async (req, res, next) => {
  try {
    const item = await loadCard(req);
    if (!item) return res.status(404).render("errors/404");
    res.render("mediaForm", formModel(req, { item }));
  } catch (err) {
    next(err);
  }
});

router.post(`/:channel/${SECTION}/:id/edit`, edit, settingsWriteLimiter, uploadPoster, verifyToken, async (req, res, next) => {
  try {
    const item = await loadCard(req);
    if (!item) return res.status(404).render("errors/404");

    const { errors, value, poster, picked } = await readForm(req);
    if (errors.length) return res.status(400).render("mediaForm", formModel(req, { item, values: req.body, errors }));

    const set = {
      title: value.title,
      originalTitle: value.originalTitle,
      searchKey: value.searchKey,
      year: value.year,
      mediaType: value.mediaType,
      status: value.status,
      "external.imdbId": value.imdbId,
      nsfw: value.nsfw,
      recordingUrl: value.recordingUrl,
      progress: value.progress,
    };
    if (value.status === "done" && item.status !== "done") set.doneAt = new Date();
    if (poster) set.poster = poster;
    // A different IMDb id makes the stored IMDb rating someone else's; the nightly pass fills in
    // the new one.
    if ((value.imdbId || null) !== (item.external?.imdbId || null)) set["ratings.external"] = null;
    // A new pick replaces the source ids; no pick leaves them as they were.
    if (picked) {
      const ids = externalIds(value, picked);
      set["external.tmdbId"] = ids.tmdbId ?? null;
      set["external.tmdbType"] = ids.tmdbType ?? null;
      set["external.shikimoriId"] = ids.shikimoriId ?? null;
    }
    if (canWriteStreamerFields(req.permission)) {
      set["ratings.streamer"] = value.streamerRating;
      set.review = value.review
        ? { ...value.review, authorUserId: req.user.userId, updatedAt: new Date() }
        : null;
    }

    try {
      await mediaItemsRepo.update(item._id, set);
    } catch (err) {
      await deletePoster(poster);
      if (isDuplicate(err)) return res.status(400).render("mediaForm", formModel(req, { item, values: req.body, errors: ["duplicate"] }));
      throw err;
    }
    // The old files go only after the new ones are in the document.
    if (poster) await deletePoster(item.poster);
    await logWrite(req, "update", { ...item, title: value.title });
    res.redirect(`/${req.channel.channelLogin}/${SECTION}/${item._id}`);
  } catch (err) {
    next(err);
  }
});

router.post(`/:channel/${SECTION}/:id/delete`, edit, settingsWriteLimiter, verifyToken, async (req, res, next) => {
  try {
    const item = await loadCard(req);
    if (item) {
      await mediaItemsRepo.deleteItem(item._id);
      // Everything hanging off the card goes after the card itself, so nothing can render a
      // half-deleted state: ratings, hearts, comments and their votes, the two poster files.
      await Promise.all([
        mediaRatingsRepo.deleteAllFor(item._id),
        mediaThreads.deleteAllFor(item._id),
        deletePoster(item.poster),
      ]);
      await logWrite(req, "delete", item);
    }
    res.redirect(`/${req.channel.channelLogin}/${SECTION}`);
  } catch (err) {
    next(err);
  }
});

// --- the card's own page ----------------------------------------------------------------

router.get(`/:channel/${SECTION}/:id`, page, async (req, res, next) => {
  try {
    const { channel, permission } = req;
    const item = await loadCard(req);
    if (!item) return res.status(404).render("errors/404");

    const [broadcaster, thread, reacted, myRating, editor] = await Promise.all([
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
      discussion.threadPageLocals(req, res, channel, item),
      req.user ? mediaThreads.getUserReactions([String(item._id)], req.user.userId) : Promise.resolve(new Set()),
      req.user ? mediaRatingsRepo.getUserRating(item._id, req.user.userId) : Promise.resolve(null),
      req.user ? canEdit(req) : Promise.resolve(false),
    ]);

    res.render("mediaItem", {
      ...thread,
      broadcaster,
      channelNav: buildChannelNav(channel, { permission, active: SECTION }),
      item: {
        ...item,
        id: String(item._id),
        gridPosterUrl: gridPosterUrl(item),
        viewerAverage: media.viewerAverage(item.ratings?.viewers),
        viewerCount: item.ratings?.viewers?.count || 0,
        imdbRating: item.ratings?.external?.source === "imdb" ? item.ratings.external : null,
        likedByViewer: reacted.has(`${item._id}:like`),
        superlikedByViewer: reacted.has(`${item._id}:superlike`),
      },
      myRating: myRating ? { value: myRating.value, counted: myRating.counted } : null,
      // The owner has their own score; viewers rate only what was watched.
      canRate: Boolean(req.user) && permission !== 1 && item.status === "done",
      canEdit: editor,
      commentSortModes: COMMENT_SORT_MODES,
      sectionPreview: res.locals.sectionPreview,
      ratingFlash: typeof req.query.rated === "string" ? req.query.rated : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post(`/:channel/${SECTION}/:id/rate`, requireLogin, verifyToken, write, async (req, res, next) => {
  try {
    const { channel } = req;
    const item = await loadCard(req);
    const back = (code) => `/${channel.channelLogin}/${SECTION}/${req.params.id}?rated=${code}#rating`;
    const fail = (status, code) => (wantsJson(req) ? res.status(status).json({ ok: false, error: code }) : res.redirect(back(code)));

    if (!item) return fail(404, "not_found");
    if (item.status !== "done") return fail(400, "not_watched");
    if (req.permission === 1) return fail(403, "owner");
    if (!rateLimiterAllow(req.user.userId)) return fail(429, "rate_limited");
    const parsed = media.parseRating(req.body.value);
    if (parsed.error || parsed.value === null) return fail(400, "rating_invalid");

    const counted = await chatPresenceRepo.hasChatted(channel.channelLogin, req.user.userId);
    const previous = await mediaRatingsRepo.setRating(item._id, req.user.userId, parsed.value, counted);
    const delta = media.viewerRatingDelta(previous, parsed.value, counted);
    await mediaItemsRepo.incViewerRatings(item._id, delta);

    if (!wantsJson(req)) return res.redirect(back(counted ? "ok" : "not_counted"));
    const fresh = await mediaItemsRepo.getById(item._id);
    res.json({
      ok: true,
      value: parsed.value,
      counted,
      average: media.viewerAverage(fresh?.ratings?.viewers),
      count: fresh?.ratings?.viewers?.count || 0,
    });
  } catch (err) {
    next(err);
  }
});

router.post(`/:channel/${SECTION}/:id/react`, requireLogin, verifyToken, writeJson, async (req, res, next) => {
  try {
    if (!reactLimiterAllow(req.user.userId)) return res.status(429).json({ ok: false, error: "rate_limited" });
    const type = req.body.type;
    if (!REACTION_TYPES.includes(type)) return res.status(400).json({ ok: false, error: "invalid_type" });
    const item = await loadCard(req);
    if (!item) return res.status(404).json({ ok: false, error: "not_found" });
    const result = await mediaThreads.toggleReaction(item._id, req.user.userId, type);
    if (!result) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, liked: result.liked, count: result.count });
  } catch (err) {
    next(err);
  }
});

// Comments, votes and moderation - after the card routes; its paths are three or four segments
// deep and never collide with /:id.
router.use(discussion.router);

module.exports = router;
