// Shared client for the single-player games' leaderboard + anti-cheat run
// lifecycle. The multiplayer games already had quickMatchClient.js; the solo
// games had six near-verbatim copies of the submit/beacon/leaderboard block
// pasted into each game file (their own comments said so). This is that block,
// once, plus the run-token and input-recording machinery.
//
// Loaded as a plain <script> (no bundler in this repo) AFTER
// engines/replayCodec.js and BEFORE the game's own deferred script.
//
// Usage:
//   const run = window.SoloRun.create({
//     gameKey: "minesweeper",
//     rulesVersion: MinesweeperEngine.RULES_VERSION,
//     rootId: "ms-leaderboard", listId: "ms-lb-list",
//     meWrapId: "ms-lb-me", meRowId: "ms-lb-me-row",
//   });
// Optional `now`: the clock event timestamps come from, defaulting to
// performance.now(). A fixed-timestep game passes its own SIMULATION clock
// instead, because that - not wall time - is what the server replays against.
//
//   await run.begin();          // mints a run; run.rng is now seeded
//   run.record(OP_REVEAL, cell);
//   run.finish(score);
"use strict";

(function () {
  // Never block gameplay on the network. If run/start.json is slow or down,
  // the game starts UNRANKED rather than making the player wait - a hung
  // request must not be able to stop somebody playing.
  const START_TIMEOUT_MS = 1500;
  // Flush the recorded log to the server after this much time or this many
  // encoded characters, whichever comes first (opt-in per game). Only the two
  // open-ended games need it.
  const CHECKPOINT_INTERVAL_MS = 60000;
  const CHECKPOINT_BYTES = 32 * 1024;
  // A keepalive:true fetch body is capped by the browser at 64kB, shared
  // across all in-flight keepalive requests. Stay well under it.
  const MAX_BEACON_BYTES = 48 * 1024;

  function create(config) {
    const codec = window.ReplayCodec;
    const root = document.getElementById(config.rootId);
    const list = config.listId ? document.getElementById(config.listId) : null;
    const meWrap = config.meWrapId ? document.getElementById(config.meWrapId) : null;
    const meRow = config.meRowId ? document.getElementById(config.meRowId) : null;

    const submitUrl = root && root.dataset ? root.dataset.submitUrl : null;
    const csrf = root && root.dataset ? root.dataset.csrf : null;
    // data-submit-url is only rendered for logged-in visitors, so its absence
    // is exactly "anonymous" - the same test the old per-game code used.
    const canSubmit = Boolean(submitUrl && csrf);
    const startUrl = canSubmit ? submitUrl.replace("/score.json", "/run/start.json") : null;
    const checkpointUrl = canSubmit ? submitUrl.replace("/score.json", "/run/checkpoint.json") : null;

    let runId = null;
    let recorder = null;
    let ranked = false;
    let seedValue = 0;
    let checkpointedEvents = 0;
    let lastCheckpointAt = 0;
    let submitted = false;
    // De-dupes concurrent begin() calls. Every game's start()/startRun()
    // leaves the "play again" button clickable across the `await
    // run.begin()` gap, so an impatient repeat click (routine on a fast-death
    // game like Pipe Dodger) can fire begin() again before the first call's
    // fetch resolves. Two independent run/start.json requests racing would
    // let whichever happened to resolve last silently overwrite runId/
    // seedValue/recorder out from under a game that already started playing
    // on the other one - the submitted replay then no longer matches what
    // was actually played. Folding concurrent callers onto the SAME in-flight
    // promise means they converge on one server run and one consistent
    // result instead.
    let inFlightBegin = null;

    function form(fields) {
      const params = new URLSearchParams();
      params.set("_csrf", csrf);
      params.set("v", "2");
      for (const key of Object.keys(fields)) {
        if (fields[key] !== undefined && fields[key] !== null) params.set(key, String(fields[key]));
      }
      return params;
    }

    // --- Leaderboard (moved verbatim from the six game files) --------------

    function lbRow(row, isMe) {
      const li = document.createElement("li");
      li.className = "flex items-baseline gap-2 text-sm py-1 px-1 rounded" + (isMe ? " bg-purple-500/10" : "");
      const rank = document.createElement("span");
      rank.className = "w-5 text-right tabular-nums text-neutral-500 shrink-0";
      rank.textContent = row.rank;
      const name = document.createElement("span");
      name.className = "flex-1 truncate " + (isMe ? "text-purple-300" : "text-neutral-300");
      name.textContent = row.displayName;
      if (row.color) name.style.color = row.color;
      const points = document.createElement("span");
      points.className = "tabular-nums text-neutral-100";
      points.textContent = row.score;
      li.append(rank, name, points);
      return li;
    }

    function renderLeaderboard(data) {
      if (!list) return;
      list.textContent = "";
      if (data.rows.length === 0) {
        const li = document.createElement("li");
        li.className = "text-sm text-neutral-500 py-1";
        li.textContent = root.dataset.emptyLabel;
        list.appendChild(li);
      }
      for (const row of data.rows) list.appendChild(lbRow(row, row.isMe));
      if (!meRow || !meWrap) return;
      meRow.textContent = "";
      if (data.myRow) {
        meRow.appendChild(lbRow(data.myRow, true));
        meWrap.hidden = false;
      } else {
        meWrap.hidden = true;
      }
    }

    // --- Run lifecycle -----------------------------------------------------

    async function doBegin() {
      submitted = false;
      checkpointedEvents = 0;
      lastCheckpointAt = Date.now();
      runId = null;
      ranked = false;
      api.rng = Math.random;
      recorder = null;

      if (!canSubmit) return null;

      let data = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), START_TIMEOUT_MS);
        const response = await fetch(startUrl, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: form({}),
          signal: controller.signal,
        });
        clearTimeout(timer);
        data = response.ok ? await response.json() : null;
      } catch {
        data = null;
      }

      if (!data || !data.ok) {
        if (typeof config.onUnranked === "function") config.onUnranked();
        return null;
      }

      runId = data.runId;
      ranked = true;
      seedValue = data.seed;
      api.rng = codec.mulberry32(data.seed);
      recorder = codec.createRecorder({
        gameKey: config.gameKey,
        rulesVersion: config.rulesVersion,
        seed: data.seed,
        now: config.now || (() => performance.now()),
      });
      return { runId, seed: data.seed };
    }

    const api = {
      // True once a run token is held. A game may read this to tell the player
      // their score won't be saved.
      get ranked() {
        return ranked;
      },
      get runId() {
        return runId;
      },
      get seed() {
        return seedValue;
      },
      // Seeded while ranked, Math.random otherwise. ALWAYS go through this for
      // gameplay randomness - the server replays with the same seed, so a bare
      // Math.random() call is an instant desync.
      rng: Math.random,

      canSubmit() {
        return canSubmit;
      },

      // Call when the player actually starts playing. Safe to call again to
      // retry after a failed start (the run stays playable meanwhile). Also
      // safe to call while a previous call is still pending - concurrent
      // callers share the one in-flight request/result (see inFlightBegin).
      begin() {
        if (inFlightBegin) return inFlightBegin;
        inFlightBegin = doBegin().finally(() => {
          inFlightBegin = null;
        });
        return inFlightBegin;
      },

      // opcode 0-31, up to three u8 args. Pass synthetic=true for a DERIVED
      // event - an OS key auto-repeat, or one step of a drag gesture that
      // produced several moves from a single pointer event. Those are excluded
      // from the bot-detection timing analysis, which is what stops a player
      // who simply holds an arrow key from being flagged.
      record(opcode, a, b, c, synthetic) {
        if (!recorder) return;
        recorder.push(opcode, a, b, c, synthetic);
        if (config.checkpoint) maybeCheckpoint();
      },

      eventCount() {
        return recorder ? recorder.eventCount() : 0;
      },

      // Game over. Renders the returned leaderboard.
      finish(claimedScore, extra) {
        if (!canSubmit || submitted || !(claimedScore >= 1)) return;
        submitted = true;
        const body = { score: String(claimedScore), ...(extra || {}) };
        if (runId) {
          body.runId = runId;
          const encoded = recorder.encode(claimedScore, checkpointedEvents);
          if (encoded.length <= MAX_BEACON_BYTES) body.replay = encoded;
        }
        fetch(submitUrl, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: form(body),
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (data && data.ok) renderLeaderboard(data);
          })
          .catch(() => {});
      },

      // The "save my score and leave" path. Same run, same endpoint - a
      // partial run is a perfectly verifiable run, the server just replays as
      // far as the log goes.
      leaveBeacon(claimedScore, extra) {
        if (!canSubmit || submitted || !(claimedScore >= 1)) return;
        submitted = true;
        const body = { score: String(claimedScore), ...(extra || {}) };
        if (runId) {
          body.runId = runId;
          const encoded = recorder.encode(claimedScore, checkpointedEvents);
          if (encoded.length <= MAX_BEACON_BYTES) body.replay = encoded;
        }
        fetch(submitUrl, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: form(body),
          keepalive: true,
        }).catch(() => {});
      },

      // Restart button: drop this run's token and log without submitting.
      abandon() {
        runId = null;
        ranked = false;
        recorder = null;
        api.rng = Math.random;
      },

      // For 2048's localStorage resume: that game can be closed mid-board and
      // picked up later, and a restored board cannot be derived from a seed
      // alone - so the INPUT LOG is persisted alongside it and re-run to
      // rebuild the position.
      serialize() {
        if (!recorder || !runId) return null;
        return { runId, seed: seedValue, events: recorder.snapshot() };
      },

      // Re-adopts a saved run WITHOUT contacting the server: the run document
      // is still open (2048's runs live 24h for exactly this reason), so the
      // same token can still be cashed in.
      //
      // Note `rng` is reset to the START of the seed's stream. The caller is
      // expected to replay the saved events through its engine using this same
      // rng, which advances it to precisely where the previous session left
      // off - that replay IS the resume, and it doubles as a free client-side
      // check that the engine still reproduces the saved position.
      resume(saved) {
        if (!canSubmit || !saved || !saved.runId) return false;
        if (!Number.isInteger(saved.seed) || !Array.isArray(saved.events)) return false;
        runId = saved.runId;
        seedValue = saved.seed;
        ranked = true;
        submitted = false;
        checkpointedEvents = 0;
        lastCheckpointAt = Date.now();
        api.rng = codec.mulberry32(saved.seed);
        recorder = codec.createRecorder({
          gameKey: config.gameKey,
          rulesVersion: config.rulesVersion,
          seed: saved.seed,
          now: config.now || (() => performance.now()),
        });
        recorder.restore(saved.events);
        return true;
      },

      renderLeaderboard,
    };

    function maybeCheckpoint() {
      if (!runId || !checkpointUrl) return;
      const now = Date.now();
      const pending = recorder.eventCount() - checkpointedEvents;
      if (pending <= 0) return;
      // Cheap proxy for encoded size - events are 2-3 bytes each.
      if (now - lastCheckpointAt < CHECKPOINT_INTERVAL_MS && pending * 3 < CHECKPOINT_BYTES) return;
      lastCheckpointAt = now;
      const events = recorder.eventCount();
      const encoded = recorder.encode(0, 0);
      fetch(checkpointUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ runId, replay: encoded, events: String(events) }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          // Only advance the watermark once the server has actually banked the
          // head of the log, so a failed checkpoint just retries next tick
          // instead of losing events.
          if (data && data.ok) checkpointedEvents = events;
        })
        .catch(() => {});
    }

    return api;
  }

  // The leave-page confirmation dialog, identical in all six games. Kept as a
  // separate export rather than folded into create() so its logic stays
  // independently testable and a game can opt out.
  // options: { dialogId, saveId, discardId, cancelId, isInProgress, canSave,
  //            onOpen?, onSave?, onDiscard? }
  function wireLeaveConfirm(options) {
    const dialog = document.getElementById(options.dialogId);
    if (!dialog) return;
    const saveBtn = options.saveId ? document.getElementById(options.saveId) : null;
    const discardBtn = options.discardId ? document.getElementById(options.discardId) : null;
    const cancelBtn = options.cancelId ? document.getElementById(options.cancelId) : null;
    let pendingHref = null;

    document.addEventListener("click", (event) => {
      if (!options.isInProgress()) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest("a[href]");
      if (!link || link.target === "_blank") return;
      event.preventDefault();
      pendingHref = link.href;
      // Games with a live loop (cloud-climber) pause here, so the world isn't
      // still moving - and the player isn't still dying - behind the dialog.
      if (options.onOpen) options.onOpen();
      if (saveBtn) saveBtn.hidden = !options.canSave();
      dialog.showModal();
    });

    cancelBtn?.addEventListener("click", () => dialog.close());
    discardBtn?.addEventListener("click", () => {
      if (options.onDiscard) options.onDiscard();
      dialog.close();
      if (pendingHref) location.href = pendingHref;
    });
    saveBtn?.addEventListener("click", () => {
      if (options.onSave) options.onSave();
      dialog.close();
      if (pendingHref) location.href = pendingHref;
    });

    window.addEventListener("beforeunload", (event) => {
      if (!options.isInProgress()) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  window.SoloRun = { create, wireLeaveConfirm };
})();
