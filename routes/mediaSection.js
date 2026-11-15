// /:channel/movies - what the channel has watched on stream: a grid of cards, each with the
// streamer's score and review, the viewers' star average and a discussion. Off by default per
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
//   - a viewer's score and comments: anyone logged in; the score on any card but a rejected one,
//     never by the owner (they have their own), and only counted in the average for someone who
//     has chatted in the channel (db/chatPresenceRepo.js);
//   - suggesting a film: levels 0-2, and any logged-in viewer who has chatted in the channel, at
//     most three waiting at a time; no duplicates in any status (lib/mediaSuggestions.js). A viewer
//     may upload a cover, through the barrier in lib/userImageGuard.js, and it stays hidden from
//     everyone but its author and 0-2 until approved;
//   - promote / not-now votes on suggestions: anyone logged in, the author included; counted for
//     people who have chatted. Accepting, rejecting (with a reason) and reopening a suggestion, and
//     approving or removing a viewer's cover, are behind the same "discussions" right as editing.
//
// Writes by the owner or a moderator go to the channel's SettingsChangeLog (category "media");
// the admin's go to AdminActionLogs, like every other admin action.
//
// The grid pages by cursor (lib/cursorPaging.js's in-memory variant): a sort by a rating cannot be
// served by Mongo (the viewer average is computed on read), and a channel has hundreds of cards,
// not tens of thousands. 24 per portion - a full last row at 2, 3, 4 and 6 columns.
const express = require("express");
const { infoIsStale, INFO_VERSION } = require("../lib/mediaInfo");
const multer = require("multer");
const mediaItemsRepo = require("../db/mediaItemsRepo");
const mediaRatingsRepo = require("../db/mediaRatingsRepo");
const mediaSuggestionVotesRepo = require("../db/mediaSuggestionVotesRepo");
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
const { savePoster, deletePoster, gridPosterUrl, isPosterVisible } = require("../lib/mediaImage");
const suggestions = require("../lib/mediaSuggestions");
const imageGuard = require("../lib/userImageGuard");
const { sanitizeReturnTo } = require("../lib/returnTo");
const { fetchAllowedImage } = require("../lib/remoteImage");
const { isAllowedMediaImageUrl } = require("../lib/mediaImageHosts");
const { createDiscussionRoutes } = require("./discussionRoutes");

// The moderator right that covers this section's cards (lib/moderatorSections.js).
const EDIT_SECTION = "discussions";
const ITEMS_PER_PORTION = 24;
// "Back" restore ceiling, as on the news feed.
const RESTORE_MAX = 240;
const POSTER_MAX_BYTES = 5 * 1024 * 1024;
// The grid's tabs. Suggestions holds both the candidates and the accepted ones ("planned"), sorted
// by votes by default; rejected suggestions are not public - that tab exists for levels 0-2 only.
const TABS = {
  done: { statuses: ["done"], defaultSort: "added" },
  suggestions: { statuses: suggestions.OPEN_STATUSES, defaultSort: "score" },
  rejected: { statuses: ["rejected"], defaultSort: "added", moderatorsOnly: true },
};
// A link from before suggestions existed: "planned" now lives in the suggestions tab.
const TAB_ALIASES = { planned: "suggestions" };
const visibleTabs = (permission) => Object.keys(TABS).filter((key) => !TABS[key].moderatorsOnly || permission <= 2);

const rateLimiterAllow = createSimpleLimiter({ windowMs: 60 * 1000, max: 20 });
// The search box fires on typing (debounced client-side); this only stops a script.
const lookupLimiterAllow = createSimpleLimiter({ windowMs: 60 * 1000, max: 60 });

const voteLimiterAllow = createSimpleLimiter({ windowMs: 60 * 1000, max: 30 });
const suggestLimiterAllow = createSimpleLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
// A viewer's cover uploads: 5 an hour and 20 a day per person, on top of the three-open ceiling.
// In process memory like the site's other limiters - a restart forgets them, which costs at most one
// extra hour's worth.
const viewerUploadHourAllow = createSimpleLimiter({ windowMs: 60 * 60 * 1000, max: 5 });
const viewerUploadDayAllow = createSimpleLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 20 });
// One viewer upload decoded at a time, three waiting; the rest get 503 (lib/userImageGuard.js).
const viewerUploadGate = imageGuard.createUploadGate();

// The viewer's form is held to exactly what it has: one file, a handful of fields. Anything more is
// refused before the body is read further. The file's own name and type are never looked at - the
// barrier reads its bytes.
const viewerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: POSTER_MAX_BYTES, files: 1, fields: 20, parts: 21, fieldSize: 8 * 1024 },
});

function uploadViewerPoster(req, res, next) {
  viewerUpload.single("poster")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      req.posterUploadError = true;
      return next();
    }
    next(err);
  });
}

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

/**
 * @param {object} cfg  a section config - see routes/movies.js and routes/gamesStream.js
 */
function createMediaSectionRouter(cfg) {
  const router = express.Router();
  const SECTION = cfg.section;
  const KIND = cfg.kind;

  // What every view of this section reads: `sec` (path, look, which form fields exist) and `st`, the
  // section's translator - "<section>.<key>", falling back to the movie wording, so a section only
  // carries the strings that differ (a game is "added", not "watched"; it has no IMDb).
  router.use(`/:channel/${SECTION}`, (req, res, next) => {
    const t = res.locals.t;
    res.locals.sec = cfg.view;
    res.locals.st = (key, vars) => {
      const own = `${cfg.view.i18n}.${key}`;
      const text = t(own, vars);
      return text === own ? t(`movies.${key}`, vars) : text;
    };
    next();
  });

  // The outside rating as every view draws it: {source: 'imdb'|'steam', value, votes} or null.
  const externalRatingOf = (item) => (item.ratings?.external?.source ? item.ratings.external : null);

  const page = loadChannelSection(SECTION);
  const pageJson = loadChannelSection(SECTION, { json: true });
  const write = loadChannelSection(SECTION, { allowPreview: false });
  // Editors work in preview too: the admin fills the section before switching it on. Checked before
  // multer reads the body, so an anonymous request never gets a 5 MB upload buffered.
  const edit = [requireSectionEditAccess(EDIT_SECTION), loadChannelSection(SECTION)];

  // The search behind the card form - the section's own sources (lib/mediaSources/), one instance
  // and one cache per section for the process.
  const mediaSources = cfg.sources;

  const discussion = createDiscussionRoutes({
    section: SECTION,
    store: mediaThreads,
    getItem: async (id) => {
      const item = await mediaItemsRepo.getById(id);
      return item && item.kind === KIND ? item : null;
    },
    adminActionPrefix: "mediaComment",
  });

  // requireSectionEditAccess's rule, answered without rejecting - for drawing the buttons.
  function canEdit(req) {
    return canEditSectionAt(req.permission, req.channel.channelId, req.user?.userId, EDIT_SECTION);
  }

  // The review and the streamer's score: the owner, or the admin on the owner's behalf.
  const canWriteStreamerFields = (permission) => permission <= 1;

  const viewerOf = (req) => ({ userId: req.user?.userId || null, permission: req.permission });

  // The card's poster as THIS viewer may see it: null when it is a viewer's upload still waiting for
  // approval and they are neither its author nor 0-2 - then not even the blurred copy's URL reaches
  // the page.
  const posterFor = (item, viewer) => (isPosterVisible(item, viewer) ? item.poster : null);

  // A rejected suggestion is not public: its page answers only 0-2 and the person who suggested it.
  function canSeeCard(item, viewer) {
    if (item.status !== "rejected") return true;
    if (viewer.permission <= 2) return true;
    return Boolean(viewer.userId) && String(viewer.userId) === String(item.suggestion?.userId);
  }

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

  function readGridQuery(query, permission) {
    const asked = TAB_ALIASES[query.tab] || query.tab;
    const tab = visibleTabs(permission).includes(asked) ? asked : "done";
    // An explicit sort wins; otherwise the tab's own default (votes on the suggestions tab).
    const sort = cfg.sorts.includes(query.sort) ? query.sort : TABS[tab].defaultSort;
    const q = typeof query.q === "string" ? query.q.slice(0, 100) : "";
    // Type and genre narrow the grid; both read as "all" when absent or unknown. Type exists only
    // where the form has the field (films/series/anime); a genre is matched against the card's
    // stored `info.genres` and `info.tags` (lib/mediaInfo.js - tags are games' Steam tags), so a
    // card saved without info never matches one.
    const type = cfg.view.fields.mediaType && media.MEDIA_TYPES.includes(query.type) ? query.type : "";
    const genre = typeof query.genre === "string" ? query.genre.trim().slice(0, 60) : "";
    return { tab, sort, q, type, genre };
  }

  // The genres and the tags a tab's cards carry, each most common first - the options of the grid's
  // genre filter. Computed from the tab's rows before the type/genre filters, so picking one does not
  // shrink the list of the others. A name that is both a genre and a tag is listed as a genre.
  function genresOf(rows) {
    const count = (field) => {
      const counts = new Map();
      for (const row of rows) for (const g of row.info?.[field] || []) counts.set(g, (counts.get(g) || 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
    };
    const genres = count("genres");
    return { genres, tags: count("tags").filter((t) => !genres.includes(t)) };
  }

  const labelsOf = (row) => [...(row.info?.genres || []), ...(row.info?.tags || [])];
  // The search box finds a card by its title or by one of its genres/tags ("рогалик", "Roguelike").
  const matchesQuery = (row, q) =>
    media.matchesSearch(row.searchKey, q) || (q !== "" && labelsOf(row).some((l) => media.matchesSearch(media.normalizeSearchText(l), q)));

  // Which sorts a tab offers: the vote score only means something where there are votes.
  const sortsFor = (tab) => cfg.sorts.filter((key) => key !== "score" || tab !== "done");

  // The whole filtered, sorted list for one grid view; portions are sliced from it.
  // Returns { rows, genres }: rows filtered and sorted, genres from the whole tab (genresOf).
  async function gridRows(channel, { tab, sort, q, type, genre }) {
    let rows = await mediaItemsRepo.listForGrid(channel.channelLogin, KIND, TABS[tab].statuses);
    // Section-specific facts computed per request (a game's hours on stream), before sorting: one of
    // them may be the sort key.
    if (cfg.decorateRows) rows = await cfg.decorateRows(channel, rows);
    const spec = media.SORTS[sort];
    const filtered = rows
      .filter((r) => matchesQuery(r, q))
      .filter((r) => !type || r.mediaType === type)
      .filter((r) => !genre || labelsOf(r).includes(genre))
      .map(media.withSortKeys)
      .sort(cursorPaging.compareBySpec(spec));
    return { rows: filtered, genres: genresOf(rows) };
  }

  function shapeCard(item, viewer = {}, myVotes = new Map()) {
    const poster = posterFor(item, viewer);
    return {
      id: String(item._id),
      title: item.title,
      originalTitle: item.originalTitle,
      year: item.year,
      mediaType: item.mediaType,
      status: item.status,
      nsfw: item.nsfw,
      posterUrl: poster ? gridPosterUrl({ ...item, poster }) : null,
      // Shown to the author and 0-2 only (the only ones who can see a pending cover at all).
      posterPending: Boolean(poster && poster.approved === false),
      progress: media.progressBadge(item.progress),
      streamerRating: item.ratings?.streamer ?? null,
      viewerAverage: media.viewerAverage(item.ratings?.viewers),
      externalRating: externalRatingOf(item),
    extras: cfg.cardExtras ? cfg.cardExtras(item) : null,
      excerpt: item.review?.excerpt || null,
      commentCount: item.commentCount || 0,
      isSuggestion: Boolean(item.suggestion),
      votable: suggestions.isVotable(item),
      score: item.votes?.score || 0,
      myVote: myVotes.get(String(item._id)) || 0,
    };
  }

  // The viewer's own votes on the cards of a portion - one query, only where voting is possible.
  async function myVotesFor(items, req) {
    if (!req.user) return new Map();
    const votable = items.filter(suggestions.isVotable).map((i) => String(i._id));
    return votable.length ? mediaSuggestionVotesRepo.getUserVotes(votable, req.user.userId) : new Map();
  }

  // Whether this request's person may suggest: 0-2 always, others after chatting in the channel.
  async function suggestAccess(req) {
    if (!req.user) return { allowed: false, reason: "login" };
    if (req.permission <= 2) return { allowed: true };
    const chatted = await chatPresenceRepo.hasChatted(req.channel.channelLogin, req.user.userId);
    return suggestions.canSuggest({ loggedIn: true, permission: req.permission, chatted }) ? { allowed: true } : { allowed: false, reason: "chat" };
  }

  function gridUrl(channel, { tab, sort, q, type, genre }, extra = {}) {
    const params = new URLSearchParams();
    if (tab !== "done") params.set("tab", tab);
    if (sort !== TABS[tab].defaultSort) params.set("sort", sort);
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    if (genre) params.set("genre", genre);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    const qs = params.toString();
    return `/${channel.channelLogin}/${SECTION}${qs ? `?${qs}` : ""}`;
  }

  const listSrcOf = (channel, view) =>
    `/${channel.channelLogin}/${SECTION}/list.json?${new URLSearchParams({ tab: view.tab, sort: view.sort, q: view.q, type: view.type, genre: view.genre })}`;
  const restoreKeyOf = (channel, view) =>
    `${SECTION}:${channel.channelLogin}:${view.tab}:${view.sort}:${view.q}:${view.type}:${view.genre}`;

  router.get(`/:channel/${SECTION}`, page, async (req, res, next) => {
    try {
      const { channel, permission } = req;
      const view = readGridQuery(req.query, permission);
      const spec = media.SORTS[view.sort];
      const parsed = cursorPaging.parseCursor(spec, req.query.cursor);
      if (parsed.error) return res.status(400).render("errors/400", { backHref: gridUrl(channel, view) });

      const [{ rows, genres }, counts, broadcaster, editor, suggest] = await Promise.all([
        gridRows(channel, view),
        mediaItemsRepo.countByStatus(channel.channelLogin, KIND),
        profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
        req.user ? canEdit(req) : Promise.resolve(false),
        view.tab === "suggestions" ? suggestAccess(req) : Promise.resolve(null),
      ]);
      const { items, nextCursor } = cursorPaging.pageSorted(spec, rows, parsed.cursor, ITEMS_PER_PORTION);
      const myVotes = await myVotesFor(items, req);
      const viewer = viewerOf(req);

      res.render("mediaGrid", {
        channel,
        broadcaster,
        channelNav: buildChannelNav(channel, { permission, active: SECTION }),
        cards: items.map((item) => shapeCard(item, viewer, myVotes)),
        view,
        sorts: sortsFor(view.tab),
        tabs: visibleTabs(permission).map((key) => ({
          key,
          count: TABS[key].statuses.reduce((n, st) => n + (counts[st] || 0), 0),
          href: gridUrl(channel, { ...view, tab: key, sort: TABS[key].defaultSort }),
        })),
        genres: genres.genres,
        tags: genres.tags,
        // A genre from a link (a chip on a card's page) that no card of this tab carries.
        strayGenre: view.genre && !genres.genres.includes(view.genre) && !genres.tags.includes(view.genre) ? view.genre : null,
        mediaTypes: cfg.view.fields.mediaType ? media.MEDIA_TYPES : [],
        suggest,
        csrf: req.user ? res.locals.csrfToken || "" : "",
        nextHref: nextCursor ? gridUrl(channel, view, { cursor: nextCursor }) : null,
        listSrc: listSrcOf(channel, view),
        restoreKey: parsed.cursor ? null : restoreKeyOf(channel, view),
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
      const view = readGridQuery(req.query, req.permission);
      const spec = media.SORTS[view.sort];
      const { rows } = await gridRows(channel, view);

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

      const myVotes = await myVotesFor(portion.items, req);
      const viewer = viewerOf(req);
      const cards = portion.items.map((item) => shapeCard(item, viewer, myVotes));
      const csrf = req.user ? res.locals.csrfToken || "" : "";
      res.render("partials/mediaCards", { cards, channel, section: SECTION, csrf }, (err, html) => {
        if (err) return next(err);
        // The page's own URL, list source and restore key for this view: the grid's live filter
        // (public/js/media-grid.js) swaps the whole grid for a first portion and needs all three.
        res.json({
          ok: true,
          html,
          nextCursor: portion.nextCursor,
          restored,
          total: rows.length,
          pageHref: gridUrl(channel, view),
          listSrc: listSrcOf(channel, view),
          restoreKey: restoreKeyOf(channel, view),
        });
      });
    } catch (err) {
      next(err);
    }
  });

  // --- search in outside sources (the editor's autofill) ----------------------------------
  // ?tab=films|anime&q=...  -> {results: [{ref, title, originalTitle, year, mediaType, previewUrl}]}
  // ?ref=tmdb:movie:27205   -> {details: {..., imdbId, episodes, posterUrl, nsfwHint}}
  // For people who may write a card: editors, and those who may suggest - it spends other services'
  // quotas on the site's behalf. Declared before /:id.
  router.get(`/:channel/${SECTION}/lookup.json`, requireLogin, pageJson, async (req, res, next) => {
    try {
      const allowed = (await canEdit(req)) || (await suggestAccess(req)).allowed;
      if (!allowed) return res.status(403).json({ ok: false, error: "forbidden" });
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

  // The statuses an edit may set: the editor's two, plus the card's own when it is a suggestion (an
  // editor fixing a typo in a suggestion must not be forced to decide it in the same save).
  const editStatusesFor = (item) => [...new Set([...(item && !media.EDITOR_STATUSES.includes(item.status) ? [item.status] : []), ...media.EDITOR_STATUSES])];

  function formModel(req, { item = null, values = null, errors = [], mode = "edit", duplicate = null, extras = {} } = {}) {
    const src = values || (item
      ? {
          title: item.title,
          originalTitle: item.originalTitle || "",
          year: item.year ?? "",
          mediaType: item.mediaType,
          status: item.status,
          ...(cfg.formValues ? cfg.formValues(item) : {}),
          nsfw: item.nsfw,
          recordingUrl: item.recordingUrl || "",
          progressDone: item.progress?.done ?? "",
          progressTotal: item.progress?.unit === "episode" ? item.progress.total ?? "" : "",
          streamerRating: item.ratings?.streamer ?? "",
          review: item.review?.bodyRaw || "",
        }
      : { mediaType: cfg.view.defaultMediaType, status: "done" });
    return {
      channel: req.channel,
      item,
      values: src,
      errors,
      mediaTypes: media.MEDIA_TYPES,
      statuses: editStatusesFor(item),
      canWriteStreamerFields: mode === "edit" && canWriteStreamerFields(req.permission),
      mode,
      duplicate: duplicate
        ? { href: `/${req.channel.channelLogin}/${SECTION}/${duplicate._id}`, title: duplicate.title, reason: duplicate.rejectReason || null }
        : null,
      noteMax: suggestions.NOTE_MAX,
      ...extras,
      posterUrl: item?.poster?.url || null,
      canRestorePoster: mode === "edit" && canRestorePoster(item),
      lookupSources: mediaSources.describe(),
      lookupUrl: `/${req.channel.channelLogin}/${SECTION}/lookup.json`,
    };
  }

  router.get(`/:channel/${SECTION}/new`, edit, async (req, res, next) => {
    try {
      // A section may prefill from the query (games: ?category= from "played on stream, no card").
      const values = cfg.prefill ? { mediaType: cfg.view.defaultMediaType, status: "done", ...cfg.prefill(req.query) } : null;
      const extras = cfg.formExtras ? await cfg.formExtras(req.channel) : {};
      res.render("mediaForm", formModel(req, { values, extras }));
    } catch (err) {
      next(err);
    }
  });

  // Shared by create and edit: parse, validate, store the poster. Returns {errors} or {value, poster}.
  //
  // A result picked in the search box arrives as `sourceRef` only. Its details - the source's own
  // ids and the poster URL - are asked for again here, by the server, and only that answer is used:
  // a poster URL is never read from the form, or the form would be a way to make our server fetch
  // any address. An uploaded file wins over the source's poster. A poster that fails to download
  // does not block the save; the card is stored without one and can get it later.
  // `item` is the card being edited (null on create). On an edit the source's cover is fetched again
  // only when it can be a different picture: a new pick, a card with no cover yet, or the section's
  // own "the id the cover was built from changed" (games: another Steam app). Otherwise every save
  // of a game card with a Steam id would re-download the same art and replace a cover someone
  // uploaded by hand.
  async function readForm(req, { allowedStatuses, item = null } = {}) {
    const { errors, value } = cfg.parseForm(req.body, { canWriteStreamerFields: canWriteStreamerFields(req.permission), allowedStatuses });
    if (req.posterUploadError) errors.push("poster_invalid");

    let picked = null;
    if (typeof req.body.sourceRef === "string" && req.body.sourceRef) {
      picked = await mediaSources.details(req.body.sourceRef);
      if (!picked) errors.push("source_unavailable");
    }

    // "Bring back the automatic cover": the card's own source is asked again, the way a fresh pick
    // would be - never a URL from the form. Only on an edit, and an uploaded file still wins.
    const restore = Boolean(item) && req.body.posterRestore === "1" && !req.file;

    let poster = null;
    if (errors.length === 0 && restore) {
      const ref = picked ? null : sourceRefOf(item);
      const source = picked || (ref ? await mediaSources.details(ref) : null);
      poster = await downloadSourcePoster(value, source);
      if (!poster) errors.push("poster_restore_failed");
    } else if (errors.length === 0 && req.file) {
      try {
        poster = await savePoster(req.file.buffer);
      } catch {
        errors.push("poster_invalid");
      }
    } else if (errors.length === 0 && (!item || picked || !item.poster || (cfg.posterOutdated && cfg.posterOutdated(value, item)))) {
      poster = await downloadSourcePoster(value, picked);
    }
    return { errors, value, poster, picked };
  }

  // The search-source ref a saved card's cover came from (cfg.sourceRef: TMDB/Shikimori for a film,
  // the Twitch category for a game), or null.
  const sourceRefOf = (item) => (cfg.sourceRef ? cfg.sourceRef(item) : null);
  // Whether "bring back the automatic cover" can work for this card: its cover is a hand upload and
  // there is somewhere to get the automatic one from (a source ref, or the section's own ids - a
  // game's Steam app).
  const canRestorePoster = (item) =>
    Boolean(item?.poster) && item.poster.source === "upload" && Boolean(sourceRefOf(item) || (cfg.posterUrlsFor && cfg.posterUrlsFor(cfg.formValues ? cfg.formValues(item) : {}, null).length));

  // The card's `external` ids come from the section config (cfg.externalIds): what the form may
  // carry (an IMDb id, a Steam link) plus the search source's own id, only from the server-side
  // details.
  const externalIds = (value, picked) => cfg.externalIds(value, picked);

  // The poster a search pick (or an id on the form) points at - a URL the SERVER produced: from the
  // source's own answer, or built by the config from a validated numeric id. Never a URL the form
  // posted. A failed download does not block the save; the card is stored without one.
  async function downloadSourcePoster(value, picked) {
    // Each candidate is a URL or {url, source} - the source the picture really comes from, which is
    // not always the pick's (a game picked on Twitch gets Steam's art when it has a Steam id).
    const candidates = cfg.posterUrlsFor ? cfg.posterUrlsFor(value, picked) : picked?.posterUrl ? [picked.posterUrl] : [];
    for (const candidate of candidates) {
      const url = typeof candidate === "string" ? candidate : candidate.url;
      const source = (typeof candidate === "string" ? null : candidate.source) || picked?.source || cfg.view.posterSource || "source";
      try {
        const buffer = await fetchAllowedImage(url, { isAllowed: isAllowedMediaImageUrl });
        return await savePoster(buffer, { source });
      } catch (err) {
        console.warn(`[${SECTION}] poster not saved: ${err.code || err.message}`);
      }
    }
    return null;
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
          info: picked?.info || null,
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
      if (cfg.afterSave) cfg.afterSave(item);
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

      const { errors, value, poster, picked } = await readForm(req, { allowedStatuses: editStatusesFor(item), item });
      if (errors.length) return res.status(400).render("mediaForm", formModel(req, { item, values: req.body, errors }));

      const set = {
        title: value.title,
        originalTitle: value.originalTitle,
        searchKey: value.searchKey,
        year: value.year,
        mediaType: value.mediaType,
        status: value.status,
        nsfw: value.nsfw,
        recordingUrl: value.recordingUrl,
        progress: value.progress,
      };
      if (value.status === "done" && item.status !== "done") set.doneAt = new Date();
      if (poster) set.poster = poster;
      // The section's own fields and ids (an IMDb or Steam id, a game's state); the config also clears
      // an outside rating that belonged to an id the card no longer has.
      Object.assign(set, cfg.editSet(value, item, picked));
      // A new pick is possibly another film: its info replaces the old one's.
      if (picked) set.info = picked.info || null;
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
      if (cfg.afterSave) cfg.afterSave(await mediaItemsRepo.getById(item._id));
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
        // half-deleted state: ratings, suggestion votes, comments and their votes, the poster files.
        await Promise.all([
          mediaRatingsRepo.deleteAllFor(item._id),
          mediaSuggestionVotesRepo.deleteAllFor(item._id),
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

  // --- viewer suggestions --------------------------------------------------------------------
  // Static tail, before /:id like /new and /list.json.

  router.get(`/:channel/${SECTION}/suggest`, requireLogin, page, async (req, res, next) => {
    try {
      const access = await suggestAccess(req);
      if (!access.allowed) return res.status(403).render("errors/403", { requiredLevel: null, message: res.locals.st("suggest.notAllowed") });
      res.render("mediaForm", formModel(req, { mode: "suggest", values: { mediaType: cfg.view.defaultMediaType } }));
    } catch (err) {
      next(err);
    }
  });

  // Stores a viewer's cover through the barrier. Returns {poster} or {error}.
  async function saveViewerPoster(req) {
    if (req.posterUploadError) return { error: "poster_invalid" };
    if (!req.file) return {};
    const trusted = req.permission <= 2;
    if (!trusted) {
      if (!viewerUploadHourAllow(req.user.userId) || !viewerUploadDayAllow(req.user.userId)) return { error: "upload_limit" };
    }
    try {
      await imageGuard.inspectUserImage(req.file.buffer);
      const save = () => savePoster(req.file.buffer, { sharpOptions: imageGuard.STRICT_SHARP_OPTIONS, approved: trusted });
      return { poster: trusted ? await save() : await viewerUploadGate.run(save) };
    } catch (err) {
      if (err.code === "busy") return { error: "busy" };
      return { error: "poster_invalid" };
    } finally {
      // Nothing of the original is kept - not even in memory past this request.
      req.file.buffer = null;
    }
  }

  router.post(`/:channel/${SECTION}/suggest`, requireLogin, write, uploadViewerPoster, verifyToken, async (req, res, next) => {
    const reject = (status, errors, extra = {}) =>
      res.status(status).render("mediaForm", formModel(req, { mode: "suggest", values: req.body, errors, ...extra }));
    try {
      const { channel } = req;
      const access = await suggestAccess(req);
      if (!access.allowed) return res.status(403).render("errors/403", { requiredLevel: null, message: res.locals.st("suggest.notAllowed") });
      if (!suggestLimiterAllow(req.user.userId)) return reject(429, ["rate_limited"]);
      if (req.permission > 2) {
        const open = await mediaItemsRepo.countOpenSuggestions(channel.channelLogin, KIND, req.user.userId);
        if (open >= suggestions.MAX_OPEN_SUGGESTIONS) return reject(400, ["too_many_open"]);
      }

      const { errors, value } = cfg.parseSuggestionForm(req.body);
      let picked = null;
      if (typeof req.body.sourceRef === "string" && req.body.sourceRef) {
        picked = await mediaSources.details(req.body.sourceRef);
        if (!picked) errors.push("source_unavailable");
      }
      if (errors.length) return reject(400, errors);

      // Duplicates in any status, by external id or by title with year.
      const external = externalIds(value, picked);
      const existing = await mediaItemsRepo.listForDuplicateCheck(channel.channelLogin, KIND);
      const dup = suggestions.findDuplicate({ ...external, title: value.title, originalTitle: value.originalTitle, year: value.year }, existing);
      if (dup) return reject(400, [`duplicate_${suggestions.duplicateOutcome(dup)}`], { duplicate: dup });

      // The cover: the person's own file through the barrier, else the picked source's poster.
      let poster = null;
      if (req.file || req.posterUploadError) {
        const saved = await saveViewerPoster(req);
        if (saved.error) return reject(saved.error === "busy" ? 503 : 400, [saved.error]);
        poster = saved.poster || null;
      } else {
        poster = await downloadSourcePoster(value, picked);
      }

      let item;
      try {
        item = await mediaItemsRepo.create({
          channelLogin: channel.channelLogin,
          kind: KIND,
          ...value,
          streamerRating: null,
          review: null,
          external,
          info: picked?.info || null,
          poster,
          suggestion: {
            userId: String(req.user.userId),
            login: req.user.login,
            displayName: req.user.displayName || req.user.login,
            note: value.note,
            createdAt: new Date(),
          },
          createdBy: { userId: req.user.userId, login: req.user.login, level: req.permission },
        });
      } catch (err) {
        await deletePoster(poster);
        // Two people suggesting the same id at once: the index decides, the second gets the first's card.
        if (isDuplicate(err)) {
          const again = suggestions.findDuplicate({ ...external, title: value.title, year: value.year }, await mediaItemsRepo.listForDuplicateCheck(channel.channelLogin, KIND));
          return reject(400, [again ? `duplicate_${suggestions.duplicateOutcome(again)}` : "duplicate"], { duplicate: again });
        }
        throw err;
      }
      if (cfg.afterSave) cfg.afterSave(item);
      res.redirect(`/${channel.channelLogin}/${SECTION}/${item._id}`);
    } catch (err) {
      next(err);
    }
  });

  // Promote (+1) / not now (-1). The same button again takes the vote back; "clear" is what the no-JS
  // form posts for the button already pressed.
  router.post(`/:channel/${SECTION}/:id/vote`, requireLogin, verifyToken, write, async (req, res, next) => {
    try {
      const { channel } = req;
      const item = await loadCard(req);
      const back = sanitizeReturnTo(req.body.returnTo) || `/${channel.channelLogin}/${SECTION}/${req.params.id}`;
      const fail = (status, code) => (wantsJson(req) ? res.status(status).json({ ok: false, error: code }) : res.redirect(`${back}#vote-${req.params.id}`));
      if (!item || !canSeeCard(item, viewerOf(req))) return fail(404, "not_found");
      if (!suggestions.isVotable(item)) return fail(400, "not_votable");
      if (!voteLimiterAllow(req.user.userId)) return fail(429, "rate_limited");

      const previous = await mediaSuggestionVotesRepo.getUserVote(item._id, req.user.userId);
      const value = suggestions.nextVote(previous?.value || 0, req.body.value);
      if (value === null) return fail(400, "vote_invalid");
      const counted = value === 0 ? false : await chatPresenceRepo.hasChatted(channel.channelLogin, req.user.userId);
      const replaced = await mediaSuggestionVotesRepo.setVote(item._id, req.user.userId, value, counted);
      await mediaItemsRepo.incSuggestionVotes(item._id, suggestions.voteDelta(replaced, value, counted));

      if (!wantsJson(req)) return res.redirect(`${back}#vote-${req.params.id}`);
      const fresh = await mediaItemsRepo.getById(item._id);
      res.json({ ok: true, value, counted, score: fresh?.votes?.score || 0, up: fresh?.votes?.up || 0, down: fresh?.votes?.down || 0 });
    } catch (err) {
      next(err);
    }
  });

  // Deciding on a suggestion: accept (it joins the plan; its cover is approved with it), reject with a
  // reason (the reason is what a later duplicate attempt is shown), reopen a rejected one.
  const DECISIONS = {
    accept: { from: ["suggested"], to: "accepted", approvePoster: true },
    reject: { from: ["suggested", "accepted"], to: "rejected" },
    reopen: { from: ["rejected"], to: "suggested" },
  };

  router.post(`/:channel/${SECTION}/:id/decide`, edit, settingsWriteLimiter, verifyToken, async (req, res, next) => {
    try {
      const item = await loadCard(req);
      if (!item) return res.status(404).render("errors/404");
      const back = `/${req.channel.channelLogin}/${SECTION}/${item._id}`;
      const decision = DECISIONS[req.body.action];
      if (!decision || !decision.from.includes(item.status)) return res.redirect(`${back}?decided=stale#decision`);
      let rejectReason = null;
      if (req.body.action === "reject") {
        rejectReason = suggestions.cleanRejectReason(req.body.reason);
        if (!rejectReason) return res.redirect(`${back}?decided=reason_required#decision`);
      }
      const updated = await mediaItemsRepo.decide(item._id, {
        expect: decision.from,
        status: decision.to,
        decidedBy: String(req.user.userId),
        rejectReason,
        approvePoster: Boolean(decision.approvePoster && item.poster),
      });
      if (!updated) return res.redirect(`${back}?decided=stale#decision`);
      await logWrite(req, req.body.action, item);
      res.redirect(`${back}#decision`);
    } catch (err) {
      next(err);
    }
  });

  // A viewer's cover: approve it (visible to everyone) or remove it (files deleted, card keeps no cover).
  router.post(`/:channel/${SECTION}/:id/poster/:op(approve|remove)`, edit, settingsWriteLimiter, verifyToken, async (req, res, next) => {
    try {
      const item = await loadCard(req);
      if (!item) return res.status(404).render("errors/404");
      if (item.poster) {
        if (req.params.op === "approve") {
          await mediaItemsRepo.update(item._id, { "poster.approved": true });
        } else {
          await mediaItemsRepo.update(item._id, { poster: null });
          await deletePoster(item.poster);
        }
        await logWrite(req, req.params.op === "approve" ? "approvePoster" : "removePoster", item);
      }
      res.redirect(`/${req.channel.channelLogin}/${SECTION}/${item._id}`);
    } catch (err) {
      next(err);
    }
  });

  // --- the card's own page ----------------------------------------------------------------

  // A card saved before `info` existed (the field is absent, not null), or under an older shape of
  // it, gets it the first time its page is opened; until then the old block is shown as it is. A null answer is either "the source has nothing" or "the source is down" -
  // the registry does not tell them apart - so nothing is written and the card is not asked about
  // again for INFO_RETRY_MS: a TMDB outage must not turn every page view into a timed-out request.
  const INFO_RETRY_MS = 60 * 60 * 1000;
  const infoTried = new Map();
  async function fillInfo(item) {
    if (!infoIsStale(item.info) || !cfg.infoRef) return item.info || null;
    const ref = cfg.infoRef(item);
    if (!ref) return null;
    const key = String(item._id);
    if (Date.now() - (infoTried.get(key) || 0) < INFO_RETRY_MS) return item.info || null;
    infoTried.set(key, Date.now());
    if (infoTried.size > 1000) infoTried.delete(infoTried.keys().next().value);
    const details = await mediaSources.details(ref);
    if (!details) return item.info || null;
    const info = details.info || null;
    // Only where it is still stale: an edit in between wins.
    await mediaItemsRepo.setInfoIfStale(item._id, info, INFO_VERSION);
    infoTried.delete(key);
    return info;
  }

  router.get(`/:channel/${SECTION}/:id`, page, async (req, res, next) => {
    try {
      const { channel, permission } = req;
      const item = await loadCard(req);
      const viewer = viewerOf(req);
      if (!item || !canSeeCard(item, viewer)) return res.status(404).render("errors/404");

      const [broadcaster, thread, myRating, editor, myVote] = await Promise.all([
        profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
        discussion.threadPageLocals(req, res, channel, item),
        req.user ? mediaRatingsRepo.getUserRating(item._id, req.user.userId) : Promise.resolve(null),
        req.user ? canEdit(req) : Promise.resolve(false),
        req.user && suggestions.isVotable(item) ? mediaSuggestionVotesRepo.getUserVote(item._id, req.user.userId) : Promise.resolve(null),
      ]);
      const poster = posterFor(item, viewer);
      const [[decorated], info] = await Promise.all([
        cfg.decorateRows ? cfg.decorateRows(channel, [item]) : [item],
        fillInfo(item).catch(() => null),
      ]);

      res.render("mediaItem", {
        ...thread,
        broadcaster,
        channelNav: buildChannelNav(channel, { permission, active: SECTION }),
        item: {
          ...item,
          poster,
          id: String(item._id),
          gridPosterUrl: poster ? gridPosterUrl({ ...item, poster }) : null,
          posterPending: Boolean(poster && poster.approved === false),
          hasHiddenPoster: Boolean(item.poster && !poster),
          votable: suggestions.isVotable(item),
          score: item.votes?.score || 0,
          myVote: myVote?.value || 0,
          viewerAverage: media.viewerAverage(item.ratings?.viewers),
          viewerCount: item.ratings?.viewers?.count || 0,
          externalRating: externalRatingOf(item),
          info,
          extras: cfg.cardExtras ? cfg.cardExtras(decorated) : null,
        },
        myRating: myRating ? { value: myRating.value, counted: myRating.counted } : null,
        // The owner has their own score; a rejected card is not rated.
        canRate: Boolean(req.user) && permission !== 1 && suggestions.isRatable(item),
        canEdit: editor,
        decisions: editor ? Object.keys(DECISIONS).filter((key) => DECISIONS[key].from.includes(item.status)) : [],
        decidedFlash: typeof req.query.decided === "string" ? req.query.decided : null,
        csrf: req.user ? res.locals.csrfToken || "" : "",
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

      if (!item || !canSeeCard(item, viewerOf(req))) return fail(404, "not_found");
      if (!suggestions.isRatable(item)) return fail(400, "not_ratable");
      if (req.permission === 1) return fail(403, "owner");
      if (!rateLimiterAllow(req.user.userId)) return fail(429, "rate_limited");

      // "clear" takes the viewer's own rating back - the star widget sends it when the star they
      // already picked is clicked again (and the no-JS form renders that star with this value).
      const clearing = req.body.value === "clear";
      const parsed = clearing ? { value: null } : media.parseRating(req.body.value);
      if (!clearing && (parsed.error || parsed.value === null)) return fail(400, "rating_invalid");

      let counted = false;
      if (clearing) {
        const previous = await mediaRatingsRepo.removeRating(item._id, req.user.userId);
        // Leaving the average is the same move as "this rating no longer counts".
        if (previous) await mediaItemsRepo.incViewerRatings(item._id, media.viewerRatingDelta(previous, 0, false));
      } else {
        counted = await chatPresenceRepo.hasChatted(channel.channelLogin, req.user.userId);
        const previous = await mediaRatingsRepo.setRating(item._id, req.user.userId, parsed.value, counted);
        await mediaItemsRepo.incViewerRatings(item._id, media.viewerRatingDelta(previous, parsed.value, counted));
      }

      if (!wantsJson(req)) return res.redirect(back(clearing ? "cleared" : counted ? "ok" : "not_counted"));
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

  // Comments, votes and moderation - after the card routes; its paths are three or four segments
  // deep and never collide with /:id.
  router.use(discussion.router);

  return router;
}

module.exports = { createMediaSectionRouter };
