// Donation media radio: one channel's music graph (lib/musicGraph.js) with its supplies - what Mongo
// remembers, what YouTube and Last.fm answer - and the question realtime/donationMediaManager.js asks
// of it: what plays next.
//
// The graph is there to ask the outside less. Supplies are taken in order of price, and the next only
// when the ones before leave too few tracks that are close to the request (lib/musicGraph.js NEAR),
// may play again by now and are not what the channel skips:
//   1. everything Mongo knows around the roots - free;
//   2. the YouTube Mix of a root, then of the songs nearest to it - one page, two dozen tracks;
//   3. Last.fm's similar tracks, each found on YouTube by a search;
//   4. the artist's own tracks (YouTube channel, Last.fm top).
// Only when all that is not enough does it offer what lies further off, which is still better than
// nothing. Whatever an outside source finds becomes part of the graph - for the other channels too -
// and so does what the panel's own buttons find ("more of this artist", the AI's wish): see learn.
// Whether a track plays in an embedded player is remembered the same way.
//
// Beyond what is needed the graph grows a little all the time music plays: every few tracks one song
// on the edge of what is known is opened (grow), within lib/musicGrowth.js's budget.
//
// Nothing here throws at the caller: with everything outside silent, next() works with what the graph
// holds and returns [] when that is nothing.
const { GrowthPace, shared: sharedBudget } = require("./musicGrowth");
const { MusicGraph, NEAR, artistOf, nameOf, songId, classify } = require("./musicGraph");
const { MusicJudge } = require("./musicJudge");
const { artistNames } = require("./donationMediaRadio");

const BATCH = 6;
// A batch is waited for this many outside questions at most; a channel with the radio just pressed
// hears music after one.
const ASKS_MAX = 4;
// Close tracks to have in stock after a batch, and how many questions may be asked in the background
// for it. The next batch is then usually free.
const RESERVE = 8;
const STOCK_ASKS = 1;
const STOCK_PAUSE_MS = 1500;
// A track this soon after its last playing (a day or two, more for one that plays often) does not
// count as stock.
const FRESH_ENOUGH = 0.25;
// The same when the channel asked for what it knows.
const KNOWN_FRESH = 0.1;
// The part of every batch for songs the channel has never heard, so that the known ones do not close
// into a circle. While the graph has fewer of them close by, one more Mix a batch is asked for.
// By what the channel asked for (MediaQueue.musicMode).
const NEW_SHARE = { known: 0, even: 1 / 3, new: 2 / 3 };
const NEW_ASKS = { known: 0, even: 1, new: 2 };
// The same for a mood: the outside knows what is like the root, which is mostly of the root's own mood.
const MOOD_ASKS = 2;
// Questions that came back empty in a row: YouTube is down or has changed its page. Not asked again
// for a while.
const FAILURES_MAX = 3;
const BACKOFF_MS = 10 * 60 * 1000;
const DEAR_AGAIN_MS = 6 * 60 * 60 * 1000;
// Tracks known to play in the OBS player, kept ahead of need so that a skip can be answered at once.
const VERIFY_AHEAD = 12;
const VERIFY_CHUNK = 5;
const VERIFY_MAX = 30;
const EMBED_YES_MS = 30 * 24 * 60 * 60 * 1000;
const EMBED_NO_MS = 7 * 24 * 60 * 60 * 1000;
// What endless music grows from: feed tracks heard to the end this recently.
const ENDLESS_WINDOW_MS = 3 * 60 * 60 * 1000;
const ENDLESS_ROOTS = 5;
const RADIO_LISTENED = 3;
const RADIO_SEED_SHARE = 0.7;
// Skips in a row after which the radio goes back to its seed alone.
const STREAK_HOME = 3;
// Songs on the edge that another radio has opened already are free; this many are taken on the way to
// the one that is asked for.
const GROW_FREE = 3;
// An own playlist song far from what plays still has this much of a chance beside a close one's 1; and
// a tail shorter than this is chosen anew without one, or every skip would bring one up.
const OWN_FAR = 0.25;
const OWN_TAIL = 3;
// How strongly a find is joined to what it was found for, by its source. A channel's latest uploads
// are often announcements and live recordings, and songs the AI picked for one wish are similar only
// in that: enough to walk along, too little to be offered as close.
const LINKS = { mix: 0.7, lastfm: 0.6, author: 0.2, ai: 0.12 };
const LINK_OTHER = 0.3;
const withWeights = (tracks) => tracks.map((t) => ({ ...t, weight: LINKS[t.source] || LINK_OTHER }));
const LASTFM_TRACKS = 6;
// Whose tags are looked up for a choice: the likeliest songs' artists - in Mongo, and of those close to
// the request the ones not known there on Last.fm, in the background.
const TAGS_LOOKED = 300;
const TAGS_ASKED = 60;
const TAGS_REACH = 0.1;
// By mood: of so many of the likeliest, when at least so many are unknown.
const ENERGY_LOOKED = 150;
const ENERGY_WORTH = 10;
const ENERGY_WAIT_MS = 4000;
// Endless music with nothing heard yet: so many of the channel's favourites, by different artists, out
// of so many it likes most. Fewer than the least are a whim, not a taste.
const FAVOURITES = 5;
const FAVOURITES_MIN = 3;
const FAVOURITES_OUT_OF = 20;
const FAVOURITE_SCORE = 0.3;
// Opened songs whose Last.fm neighbours are looked for in Mongo.
const SIMILAR_OF = 8;
const CROWD_LOOKED = 200;
// "More of this artist" needs no outside when the graph knows this many that may play.
const ARTIST_ENOUGH = 6;

class MusicRadio {
  // sources: lib/radioSources.js ({ neighbours, similarTracks, artistTracks, embedState }); repo:
  // db/musicGraphRepo.js.
  // tags: lib/musicTagRegistry.js; energy: lib/musicEnergy.js; features: lib/musicFeatures.js; models:
  // lib/musicModels.js. Without them nothing is judged by genre, by mood or by what was learnt, and no
  // change of the choosing is on.
  constructor({ channelId, sources, repo, tags = null, features = null, energy = null, models = null, budget = sharedBudget, now = () => Date.now(), random = Math.random, pause = (ms) => new Promise((r) => setTimeout(r, ms).unref()) }) {
    this.channelId = String(channelId);
    this.sources = sources;
    this.repo = repo;
    this.now = now;
    this.random = random;
    this.pause = pause;
    this.graph = new MusicGraph({ now, random });
    this.tags = tags;
    this.features = features;
    this.energy = energy;
    this.models = models;
    this.context = {}; // { hour } of the stream, set by the manager
    this.mode = { novelty: "even", mood: "any" };
    this.rank = null;
    this.arms = {}; // which changes of the choosing are on for this batch
    this.judge = new MusicJudge({ graph: this.graph, tags });
    this.generation = 0; // a new radio: whatever was being fetched for the old one is dropped
    this.budget = budget;
    this.pace = new GrowthPace();
    this.stocking = false;
    this.growing = false;
    this.failures = 0;
    this.askAfter = 0;
    this.tried = new Map(); // "<node id>" / "lastfm:<node id>" -> when it was asked (see forgetTried)
    this.favourites = { at: 0, list: [] };
    this.similarAsked = new Set(); // node ids whose Last.fm neighbours were
    this.known = new Set(); // node ids whose surroundings Mongo was asked for
    this.identities = new Map(); // videoId -> { title, author }, see identify
    this.asks = 0; // questions put outside because tracks were needed
    this.loading = null;
  }

  async load() {
    if (!this.loading) {
      this.loading = this.repo
        .loadTaste(this.channelId)
        .then((rows) => this.graph.restoreTaste(rows))
        .then(() => this.tags && this.tags.load(this.judge.tasteSongs().map((t) => t.artist)))
        .catch((err) => {
          this.loading = null; // asked again next time; until then the radio has no taste
          this.failed("load the taste", err);
        });
    }
    return this.loading;
  }

  restart() {
    this.generation++;
    this.graph.reset();
    this.tried.clear();
    this.known.clear();
    this.similarAsked.clear();
  }

  failed(what, err) {
    console.error(`[musicRadio] ${this.channelId}: could not ${what}:`, err.message);
  }

  // Where the walk starts and returns to. queue: lib/donationMediaQueue.js's MediaQueue.
  //   a radio        its seed, and a smaller share for what was heard to the end since it started
  //   endless music  the feed tracks last heard to the end; with none, the last that started and was
  //                  not skipped together with some of the channel's favourites, or a track of the own
  //                  playlist
  rootsFor(queue) {
    return this.startsOf(queue).map((r) => ({ ...r, ...this.identities.get(r.videoId) }));
  }

  // A track of the own playlist comes with a title alone, and "Numb" by itself is no song: it would
  // stand in the graph apart from the "Linkin Park - Numb" that is known, with a Mix asked for anew.
  async identify(tracks) {
    for (const t of tracks) {
      if (t.author || this.identities.has(t.videoId)) continue;
      let known = null;
      try {
        known = await this.repo.findTrack(t.videoId);
      } catch (err) {
        this.failed("find a track", err);
      }
      if (!known || !known.author) known = await this.sources.embedState(t.videoId).catch(() => null);
      if (known && known.author) this.identities.set(t.videoId, { title: known.title || t.title, author: known.author });
    }
  }

  startsOf(queue) {
    const g = this.graph;
    if (queue.radio) {
      const seed = { ...queue.radio.seed, weight: RADIO_SEED_SHARE };
      if (g.streak.length >= STREAK_HOME) return [seed];
      const heard = g.listenedSince(queue.radio.startedAt || this.now(), RADIO_LISTENED).filter((t) => songId(t) !== songId(seed));
      const share = 1 - RADIO_SEED_SHARE;
      return [seed, ...heard.map((t, i) => ({ ...t, weight: share / Math.pow(2, i + 1) }))];
    }
    const heard = g.listenedSince(this.now() - ENDLESS_WINDOW_MS, ENDLESS_ROOTS);
    if (heard.length > 0) return heard.map((t, i) => ({ ...t, weight: Math.pow(0.6, i) }));
    const last = queue.lastBackground;
    const liked = this.favouritesNow();
    if (last && !g.streak.includes(songId(last))) return [{ ...last, weight: 1 }, ...liked.filter((t) => songId(t) !== songId(last)).map((t) => ({ ...t, weight: 1 / liked.length }))];
    if (liked.length > 0) return liked.map((t) => ({ ...t, weight: 1 }));
    const own = queue.playlist[Math.floor(this.random() * queue.playlist.length)] || last;
    return own ? [{ videoId: own.videoId, title: own.title || "", author: own.author || "", weight: 1 }] : [];
  }

  // The same few for an evening; [] when the channel has not shown enough of a taste.
  favouritesNow() {
    if (!this.features || !this.features.on("start")) return [];
    if (this.now() - this.favourites.at < ENDLESS_WINDOW_MS && this.favourites.list.every((t) => !this.graph.isClosed(songId(t)))) return this.favourites.list;
    const liked = [...this.graph.taste.entries()]
      .map(([id, rec]) => ({ videoId: rec.videoId, title: rec.title || "", author: rec.author || "", score: this.graph.trackScore(id) }))
      .filter((t) => t.videoId && t.title && t.score > FAVOURITE_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, FAVOURITES_OUT_OF)
      .map((t) => ({ t, at: t.score * (0.3 + this.random()) }))
      .sort((a, b) => b.at - a.at);
    const artists = new Set();
    const list = [];
    for (const { t } of liked) {
      const artist = artistOf(t.title, t.author) || t.videoId;
      if (artists.has(artist) || list.length >= FAVOURITES) continue;
      artists.add(artist);
      list.push({ videoId: t.videoId, title: t.title, author: t.author });
    }
    this.favourites = { at: this.now(), list: list.length >= FAVOURITES_MIN ? list : [] };
    return this.favourites.list;
  }

  // Up to `limit` tracks for the feed. exclude / excludeKeys: MediaQueue.feedExclusions().
  // `tail: false`: instead of the radio's tracks waiting there, rather than after them.
  async next(queue, { exclude, excludeKeys, limit = BATCH, tail = true } = {}) {
    const generation = this.generation;
    const stale = () => this.generation !== generation;
    await this.load();
    await this.identify(this.startsOf(queue));
    const roots = this.rootsFor(queue);
    if (stale() || roots.length === 0) return [];
    this.forgetTried();
    for (const root of roots) this.graph.addTrack(root);

    this.begin(queue);
    const options = { exclude, excludeKeys, ...this.surroundings(queue, { tail }), ...this.judging(roots) };
    let asked = 0;
    const asksBefore = this.asks;
    await this.learnKnown(roots);
    await this.learnSimilar(roots);
    while (!stale() && asked < ASKS_MAX) {
      await this.learnEnergy(roots);
      const enough = this.closeOf(roots, options, limit) >= limit;
      const moody = this.mode.mood === "any" || asked >= MOOD_ASKS || this.stockOf(roots, options, limit) >= limit;
      // A lack of new songs, or of those of the mood asked for, is worth a Mix, not the dearer sources.
      if (enough && moody && (asked >= NEW_ASKS[this.mode.novelty] || this.newOf(roots, options, limit) >= this.newIn(limit))) break;
      if (!(await this.ask(roots, { mixOnly: enough, frontier: enough }))) break;
      asked++;
    }
    await this.learnSimilar(roots);
    await this.learnTags(roots);
    await this.learnEnergy(roots);
    await this.learnCrowd(roots);
    if (stale()) return [];

    const take = async (filter, want) => {
      if (want > 0 && !stale()) await this.verify(roots, { ...options, ...filter }, want);
    };
    if (this.mode.mood !== "any") await take({ ...this.fitting(roots), minFresh: FRESH_ENOUGH }, limit);
    if (this.mode.novelty === "known") await take({ heard: true, minFresh: KNOWN_FRESH }, limit);
    await take({ near: true, unheard: true }, this.newIn(limit));
    await take({ near: true, minFresh: FRESH_ENOUGH }, limit);
    // Further off, only as much as the close ones leave open.
    await take({ unheard: true }, this.newOf(roots, options, limit) < this.newIn(limit) ? this.newIn(limit) : 0);
    await take({}, this.stockOf(roots, options, limit) < limit ? limit : 0);
    if (stale()) return [];
    const own = this.ownOf(queue, roots, options);
    await this.check(own.slice(0, 3), 1);
    if (stale()) return [];
    const tracks = this.withOwn(this.choose(roots, options, limit), own, queue, limit);
    if (tracks.length > 0 && this.asks === asksBefore) this.count("supply", "graph");
    this.stock(queue, roots);
    return tracks;
  }

  // Endless music and the channel's own playlist (MediaQueue.endlessPlaylist): one of its songs in a
  // batch, the rested, the liked and the close to what plays before the others. The graph may offer
  // more of them by itself.
  ownOf(queue, roots, { exclude, names, judge }) {
    const own = this.mode.novelty === "new" ? [] : queue.endlessPlaylist();
    if (own.length === 0) return [];
    const { reach } = this.graph.rank(roots);
    const taken = new Set(names);
    const rooted = new Set(roots.map((r) => songId(r)));
    return own
      .map((p) => ({ p, node: this.graph.addTrack({ videoId: p.videoId, title: p.title, author: p.author || "", duration: p.seconds }) }))
      .filter(({ p, node }) => node && !exclude.has(p.videoId) && !taken.has(node.name) && !rooted.has(node.id) && node.badUntil <= this.now() && !this.graph.isClosed(node.id) && this.graph.freshness(node.id) >= FRESH_ENOUGH)
      .map(({ p, node }) => ({
        weight: this.graph.freshness(node.id) * Math.exp(this.graph.trackScore(node.id)) * judge(node).factor * (OWN_FAR + (reach.get(node.id) || 0)) * (0.2 + this.random()),
        track: { videoId: p.videoId, title: p.title, author: p.author || "", duration: p.seconds, source: "playlist", node: node.id, from: null },
      }))
      .filter((c) => c.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .map((c) => c.track);
  }

  // The batch with an own song in it, if it has none yet and one is known to play.
  withOwn(tracks, own, queue, limit) {
    const mine = new Set(queue.endlessPlaylist().map((p) => songId(p)));
    if (tracks.length === 0 || tracks.some((t) => mine.has(t.node))) return tracks;
    const names = new Set(tracks.map((t) => nameOf(t.title, t.author)));
    const pick = own.find((t) => this.graph.nodes.get(t.node) && this.graph.nodes.get(t.node).verified && !names.has(nameOf(t.title, t.author)));
    if (!pick) return tracks;
    const out = tracks.length >= limit ? tracks.slice(0, -1) : tracks.slice();
    out.splice(Math.floor(this.random() * (out.length + 1)), 0, pick);
    return out;
  }

  // A batch out of what is known to play. First the share of new songs, close by if there are any;
  // then close ones that have rested, then ones further off that have: a radio that runs into its own
  // neighbourhood's bounds widens it rather than going round in it. What has not rested comes last.
  choose(roots, options, limit) {
    if (this.mode.mood !== "any" && !options.ofMood) {
      const fit = this.choose(roots, { ...options, ...this.fitting(roots), ofMood: true }, limit);
      if (fit.length >= limit) return fit;
      const left = this.choose(roots, { ...options, ofMood: true, exclude: new Set([...options.exclude, ...fit.map((t) => t.videoId)]), names: this.namesWith(options, fit) }, limit - fit.length);
      return [...fit, ...left];
    }
    const fresh = [];
    const rest = [];
    const add = (to, filter, upTo) => {
      const have = [...fresh, ...rest];
      const room = Math.min(upTo - to.length, limit - have.length);
      if (room > 0) to.push(...this.graph.pick(roots, { ...options, verified: true, ...filter, limit: room, names: this.namesWith(options, have), artists: [...options.artists, ...have.map((t) => artistOf(t.title, t.author))] }));
    };
    add(fresh, { near: true, unheard: true }, this.newIn(limit));
    add(fresh, { unheard: true }, this.newIn(limit));
    if (this.mode.novelty === "known") {
      add(rest, { near: true, heard: true, minFresh: KNOWN_FRESH }, limit);
      add(rest, { heard: true, minFresh: KNOWN_FRESH }, limit);
    }
    add(rest, { near: true, minFresh: FRESH_ENOUGH }, limit);
    add(rest, { minFresh: FRESH_ENOUGH }, limit);
    add(rest, { near: true }, limit);
    add(rest, {}, limit);
    // The new ones go between the others.
    const step = fresh.length > limit / 2 ? 2 : 3;
    fresh.forEach((t, i) => rest.splice(Math.min(rest.length, 1 + i * step), 0, t));
    rest.forEach((t, pos) => Object.assign(t.why, { pos, mode: { ...this.mode } }));
    return rest;
  }

  namesWith(options, tracks) {
    return [...options.names, ...tracks.map((t) => nameOf(t.title, t.author))];
  }

  // The same, at once: only from what is known to play. For the moment of a skip, when whatever heads
  // the feed is about to start.
  nextNow(queue, { exclude, excludeKeys, limit = BATCH } = {}) {
    const roots = this.rootsFor(queue);
    this.begin(queue);
    const options = { exclude, excludeKeys, ...this.surroundings(queue, { tail: false }), ...this.judging(roots) };
    const tracks = this.choose(roots, options, limit);
    return limit >= OWN_TAIL ? this.withOwn(tracks, this.ownOf(queue, roots, options), queue, limit) : tracks;
  }

  newIn(limit) {
    return Math.round(limit * NEW_SHARE[this.mode.novelty]);
  }

  // A batch of its own: what the channel leans to now, and which changes of the choosing are on for it.
  begin(queue) {
    this.mode = { ...queue.musicMode };
    this.rank = this.models ? this.models.forChannel(this.channelId) : null;
    this.arms = this.features ? this.features.draw() : {};
    if (!this.rank || !this.rank.inUse) delete this.arms.model;
  }

  // The part of pick's options that tilts the choice.
  judging(roots) {
    return { judge: this.judge.for(roots, this.tilt()) };
  }

  tilt() {
    return { arms: this.arms, mood: this.mode.mood, rank: this.rank, mode: this.mode, context: this.context };
  }

  // The tags of the artists a choice is likely to be among. Waits for Mongo only.
  async learnTags(roots) {
    if (!this.tags) return;
    const { p, reach } = this.graph.rank(roots);
    const rootIds = this.graph.rootIds(roots);
    const nodes = [...rootIds, ...[...p].sort((a, b) => b[1] - a[1]).slice(0, TAGS_LOOKED).map(([id]) => id)].map((id) => this.graph.nodes.get(id)).filter((n) => n && n.artist);
    await this.tags.load(nodes.map((n) => n.artist));
    const near = nodes.filter((n) => rootIds.includes(n.id) || (reach.get(n.id) || 0) >= TAGS_REACH).slice(0, TAGS_ASKED);
    this.tags.want(near.map((n) => ({ artist: n.artist, names: artistNames(n.title, n.author) })));
  }

  // How lively the songs a choice is likely to be among are, when it is by mood and there are enough to
  // ask for. Usually a second's matter; what takes longer serves the next choice.
  async learnEnergy(roots) {
    if (!this.energy || this.mode.mood === "any") return;
    const { p } = this.graph.rank(roots);
    const rootNodes = this.graph.rootIds(roots).map((id) => this.graph.nodes.get(id));
    const likely = [...p].sort((a, b) => b[1] - a[1]).slice(0, ENERGY_LOOKED).map(([id]) => this.graph.nodes.get(id)).filter((n) => n && this.graph.playable(n));
    if (likely.filter((n) => n.energy === undefined).length >= ENERGY_WORTH || rootNodes.some((n) => n.energy === undefined)) {
      const asked = this.energy.learn([...new Set([...rootNodes, ...likely])]);
      await Promise.race([asked, new Promise((r) => setTimeout(r, ENERGY_WAIT_MS).unref())]);
    }
  }

  // Songs Last.fm named next to the opened ones and some other radio has met: already paid for.
  async learnSimilar(roots) {
    if (!this.features || !this.features.on("similar")) return;
    const { reach } = this.graph.rank(roots);
    const rootIds = this.graph.rootIds(roots);
    const opened = [...this.graph.nodes.values()].filter((n) => n.lastfm.size > 0 && !this.similarAsked.has(n.id) && (rootIds.includes(n.id) || (reach.get(n.id) || 0) >= NEAR));
    opened.sort((a, b) => rootIds.includes(b.id) - rootIds.includes(a.id) || (reach.get(b.id) || 0) - (reach.get(a.id) || 0));
    const wanted = new Set();
    for (const node of opened.slice(0, SIMILAR_OF)) {
      this.similarAsked.add(node.id);
      for (const id of node.lastfm.keys()) if (!this.graph.nodes.has(id)) wanted.add(id);
    }
    if (wanted.size === 0) return;
    const generation = this.generation;
    try {
      const rows = await this.repo.findSongs([...wanted]);
      if (this.generation === generation) this.absorb(rows);
    } catch (err) {
      this.failed("find similar songs", err);
    }
  }

  async learnCrowd(roots) {
    if (!this.features || !this.features.on("crowd")) return;
    const ids = [...this.graph.rank(roots).p].sort((a, b) => b[1] - a[1]).slice(0, CROWD_LOOKED).map(([id]) => id).filter((id) => !this.graph.taste.has(id));
    try {
      this.judge.crowd = new Set(ids.length > 0 ? await this.repo.crowdSkips(this.channelId, ids) : []);
    } catch (err) {
      this.failed("ask what others skip", err);
    }
  }

  // What plays and waits, for pick. `tail: false`: without the part being chosen anew.
  surroundings(queue, { tail = true } = {}) {
    const around = [...(queue.current ? [queue.current] : []), ...queue.upNext.filter((u) => tail || !queue.isRadioTail(u))];
    const info = (t) => [t.title, t.author || (t.upNextEntry && t.upNextEntry.author) || ""];
    return { artists: around.map((t) => artistOf(...info(t))), names: around.map((t) => nameOf(...info(t))) };
  }

  // Tracks of the seed's artist the graph can offer by itself; [] when they are too few to do
  // without asking outside.
  async byArtist(seed, queue, { exclude, excludeKeys, limit = 8 } = {}) {
    await this.load();
    const artist = artistOf(seed.title, seed.author);
    if (artist.length < 2) return [];
    try {
      this.absorb(await this.repo.findByArtist(artist));
    } catch (err) {
      this.failed("find by artist", err);
    }
    const names = [...this.surroundings(queue).names, nameOf(seed.title, seed.author)];
    const known = this.graph.byArtist(artist, { exclude, excludeKeys, names });
    if (known.length < ARTIST_ENOUGH) return [];
    await this.check(known.slice(0, limit * 2), limit);
    const playing = known.filter((t) => this.graph.nodes.get(t.node) && this.graph.nodes.get(t.node).verified).slice(0, limit);
    if (playing.length < ARTIST_ENOUGH) return [];
    this.count("supply", "graph");
    return playing;
  }

  // --- what happened -----------------------------------------------------------------------------

  // A queue item ended. Returns the outcome (lib/musicGraph.js OUTCOMES) or null.
  finished(item, { status, progress, play = null }, author = "", { live = null } = {}) {
    const entry = item.upNextEntry;
    const track = { videoId: item.videoId, title: item.title, author: (entry && entry.author) || author, node: entry ? entry.node : undefined };
    const node = this.graph.nodes.get(track.node || songId(track));
    if (status === "error" && node) this.graph.markBad(node);
    const background = item.fromPlaylist === true;
    let outcome = classify(status, progress, node ? node.duration : 0, { play, live });
    // A donation or a request says nothing about the channel's taste - it only has been heard.
    if (outcome && !background) outcome = "heard";
    if (!outcome && status !== "error") return null;
    if (background) this.count(entry ? entry.source || entry.via : "playlist", outcome || "error");
    if (!outcome) {
      this.save(this.graph.record(track, "failed"));
      return null;
    }
    this.save(this.graph.record(track, outcome, { from: entry ? entry.from : null, feed: Boolean(entry) }));
    return outcome;
  }

  // A person's sign about a track that is not its playing: "liked" or "dropped".
  noted(track, outcome) {
    this.save(this.graph.record(track, outcome, { from: track.from || null }));
  }

  // Tracks found for a seed by something other than its Mix: they are its neighbours from now on.
  learn(seed, tracks) {
    const node = this.graph.addTrack(seed);
    if (!node || tracks.length === 0) return;
    this.graph.link(node, withWeights(tracks));
    this.markVerified(tracks);
    this.saveLinks(node);
  }

  // Songs picked together for one wish.
  learnWish(tracks) {
    const nodes = tracks.map((t) => this.graph.addTrack(t)).filter(Boolean);
    this.markVerified(tracks);
    for (const node of nodes) {
      this.graph.link(node, withWeights(tracks));
      this.saveLinks(node);
    }
  }

  // The panel's sources return only tracks that passed oEmbed.
  markVerified(tracks) {
    for (const t of tracks) {
      const node = this.graph.nodes.get(songId(t));
      if (node && node.videoId === t.videoId) node.verified = true;
    }
  }

  save(rows) {
    if (rows.length > 0) this.repo.saveTaste(this.channelId, rows).catch((err) => this.failed("save the taste", err));
  }

  saveLinks(node) {
    const links = [...node.links].map(([id, s]) => ({ track: this.graph.nodes.get(id), s })).filter((l) => l.track);
    if (links.length > 0) this.repo.saveLinks(node, links).catch((err) => this.failed("save links", err));
  }

  count(source, what, n = 1) {
    this.repo.count(this.channelId, String(source || "other"), what, n).catch((err) => this.failed("count", err));
  }

  // --- supplies ----------------------------------------------------------------------------------

  // A Mix that came back empty may be asked for again soon; the dear sources, not the same day.
  forgetTried() {
    for (const [id, at] of this.tried) if (this.now() - at > (/^(lastfm|artist):/.test(id) ? DEAR_AGAIN_MS : BACKOFF_MS)) this.tried.delete(id);
  }

  // How many close tracks could play now, up to `enough`.
  closeOf(roots, options, enough) {
    return this.graph.pick(roots, { ...options, limit: enough, near: true, minFresh: FRESH_ENOUGH }).length;
  }

  // The same of the mood asked for, for which it is worth looking further than NEAR.
  stockOf(roots, options, enough) {
    return this.graph.pick(roots, { ...options, ...this.fitting(roots), limit: enough, minFresh: FRESH_ENOUGH }).length;
  }

  newOf(roots, options, limit) {
    return this.graph.pick(roots, { ...options, ...this.fitting(roots), limit: this.newIn(limit), unheard: true }).length;
  }

  fitting(roots) {
    return this.mode.mood === "any" ? { near: true } : { judge: this.judge.for(roots, { ...this.tilt(), fitting: true }) };
  }

  // Mongo's rows into the graph.
  absorb(rows) {
    const byVideo = new Map(rows.map((r) => [r.videoId, r]));
    for (const row of rows) {
      const node = this.graph.addTrack(row);
      if (!node || node.videoId !== row.videoId) continue;
      if (row.energy !== undefined) node.energy = row.energy;
      if (row.embed === true && this.now() - row.embedAt < EMBED_YES_MS) node.verified = true;
      if (row.embed === false && this.now() - row.embedAt < EMBED_NO_MS) node.badUntil = row.embedAt + EMBED_NO_MS;
    }
    for (const row of rows) {
      const node = this.graph.nodes.get(songId(row));
      if (!node) continue;
      if (row.out) {
        const tracks = row.out.map((id) => byVideo.get(id)).filter(Boolean);
        if (tracks.length > 0 && tracks.length >= row.out.length / 2) this.graph.expand(node, tracks, row.similar);
      }
      this.graph.link(node, row.links.map((l) => byVideo.get(l.v) && { ...byVideo.get(l.v), weight: l.s }).filter(Boolean));
    }
  }

  async learnKnown(tracks) {
    const fresh = tracks.filter((t) => !this.known.has(songId(t)));
    if (fresh.length === 0) return;
    const generation = this.generation;
    for (const t of fresh) this.known.add(songId(t));
    try {
      const rows = await this.repo.loadAround(fresh.map((t) => ({ videoId: t.videoId, title: t.title, author: t.author })));
      if (this.generation === generation) this.absorb(rows);
    } catch (err) {
      for (const t of fresh) this.known.delete(songId(t));
      this.failed("load the surroundings", err);
    }
  }

  // One step outside: the cheapest question not asked yet. Returns whether it brought anything.
  async ask(roots, { mixOnly = false, frontier = false } = {}) {
    const generation = this.generation;
    while (this.now() >= this.askAfter) {
      const [node] = this.graph.toExpand(roots, { tried: this.tried, frontier, prefer: this.judge.prefer(roots, this.tilt()) });
      if (!node) break;
      // Another channel may have opened it since.
      await this.learnKnown([node]);
      if (this.generation !== generation) return false;
      if (node.expanded) return true;
      if (await this.open(node)) return true;
      if (this.generation !== generation) return false;
    }
    if (mixOnly) return false;
    const main = roots[0];
    const node = this.graph.nodes.get(songId(main));
    if (!node) return false;
    const other = async (kind, load) => {
      const key = `${kind}:${node.id}`;
      if (this.tried.has(key)) return false;
      this.tried.set(key, this.now());
      this.asks++;
      this.count("supply", kind);
      const tracks = await load().catch(() => []);
      if (this.generation !== generation || this.graph.nodes.get(node.id) !== node || tracks.length === 0) return false;
      this.graph.link(node, withWeights(tracks));
      this.saveLinks(node);
      return true;
    };
    if (await other("lastfm", () => this.sources.similarTracks(main, LASTFM_TRACKS))) return true;
    if (this.generation !== generation) return false;
    return other("artist", () => this.sources.artistTracks(main));
  }

  // Fetches a node's neighbours from YouTube and Last.fm. Returns whether there were any. `as`: what
  // the request is counted as.
  async open(node, as = "mix") {
    this.tried.set(node.id, this.now());
    if (as !== "grow") this.asks++;
    this.count("supply", as);
    const found = await this.sources.neighbours(node).catch(() => ({ tracks: [], similar: [] }));
    const ok = found.tracks.length > 0;
    this.failures = ok ? 0 : this.failures + 1;
    if (this.failures >= FAILURES_MAX) {
      this.failures = 0;
      this.askAfter = this.now() + BACKOFF_MS;
    }
    if (!ok) return false;
    this.repo.saveNeighbours(node, found.tracks, found.similar).catch((err) => this.failed("save neighbours", err));
    // Dropped meanwhile - another radio was started, or the graph was trimmed.
    if (this.graph.nodes.get(node.id) !== node) return false;
    const before = this.graph.nodes.size;
    this.graph.expand(node, found.tracks, found.similar);
    this.pace.opened(this.graph.nodes.size - before);
    return true;
  }

  // Called after every background track that ended while the radio or endless music is on. A step of
  // growth: one song on the edge of the known, close to what is being played, is opened. Returns
  // whether a request was made.
  async grow(queue) {
    if (!this.pace.tick() || this.growing || this.stocking || this.now() < this.askAfter) return false;
    this.growing = true;
    const generation = this.generation;
    try {
      const roots = this.rootsFor(queue);
      this.forgetTried();
      for (let i = 0; i <= GROW_FREE; i++) {
        const [node] = this.graph.toExpand(roots, { tried: this.tried, frontier: true, prefer: this.judge.prefer(roots, this.tilt()) });
        if (!node) return false;
        await this.learnKnown([node]);
        if (this.generation !== generation) return false;
        if (node.expanded) continue;
        if (!this.budget.take(this.channelId)) return false;
        this.pace.since = 0; // a step that brings nothing waits its turn too
        await this.open(node, "grow");
        return true;
      }
      return false;
    } catch (err) {
      this.failed("grow", err);
      return false;
    } finally {
      this.growing = false;
    }
  }

  // Checks tracks the graph would offer until `want` of them are known to play.
  verify(roots, options, want) {
    return this.check(this.graph.pick(roots, { ...options, limit: VERIFY_MAX }), want);
  }

  async check(candidates, want) {
    const nodeOf = (c) => this.graph.nodes.get(c.node);
    let ok = candidates.slice(0, want).filter((c) => nodeOf(c).verified).length;
    const unknown = candidates.filter((c) => !nodeOf(c).verified);
    while (unknown.length > 0 && ok < want) {
      const chunk = unknown.splice(0, Math.min(VERIFY_CHUNK, want - ok));
      this.count("supply", "oembed", chunk.length);
      const states = await Promise.all(chunk.map((c) => this.sources.embedState(c.videoId).catch(() => null)));
      chunk.forEach((c, j) => {
        const node = nodeOf(c);
        // No answer is no verdict: a track must not be out for hours because oEmbed was down.
        if (!node || !states[j]) return;
        this.repo.saveEmbed(c.videoId, states[j].embeddable).catch((err) => this.failed("save a check", err));
        if (!states[j].embeddable) return this.graph.markBad(node);
        node.verified = true;
        ok++;
      });
    }
  }

  // In the background: enough close tracks for the batch after this one, and enough of them checked.
  async stock(queue, roots) {
    if (this.stocking) return;
    this.stocking = true;
    const generation = this.generation;
    try {
      const options = { ...queue.feedExclusions({ repeats: true }), ...this.surroundings(queue), ...this.judging(roots) };
      // The track a radio was asked for gets its own Mix once, even when its neighbourhood was already
      // well stocked: seen only through other songs' Mixes it would sound like them.
      const seed = queue.radio && this.graph.nodes.get(songId(queue.radio.seed));
      if (seed && !seed.expanded && !this.tried.has(seed.id) && this.now() >= this.askAfter) {
        await this.pause(STOCK_PAUSE_MS);
        if (this.generation !== generation) return;
        await this.open(seed);
      }
      for (let i = 0; i < STOCK_ASKS && this.closeOf(roots, options, RESERVE) < RESERVE; i++) {
        await this.pause(STOCK_PAUSE_MS);
        if (this.generation !== generation || !(await this.ask(roots, { mixOnly: true }))) break;
      }
      if (this.generation !== generation) return;
      this.graph.trim(roots);
      for (const id of this.known) if (!(this.graph.nodes.get(id) || {}).expanded) this.known.delete(id);
      await this.learnEnergy(roots);
      await this.verify(roots, { ...options, ...(this.mode.mood === "any" ? { near: true } : this.fitting(roots)) }, VERIFY_AHEAD);
    } catch (err) {
      this.failed("stock up", err);
    } finally {
      this.stocking = false;
    }
  }
}

module.exports = { MusicRadio, BATCH, RESERVE, STREAK_HOME };
