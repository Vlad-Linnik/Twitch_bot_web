// The OBS browser source (views/donationMediaPlayer.ejs): plays whatever the channel's queue sends,
// on a transparent page, and reports back when a clip ends and how far it has got. The queue and
// every decision live on the server (lib/donationMediaQueue.js); this page only obeys:
//   { type: "play", item }  { type: "pause" }  { type: "resume" }  { type: "seek", time }  { type: "stop" }
//   { type: "cover", mode, blur }  mode null | "hide" | "blur" | "image" - the picture over the clip,
//                                  sound unchanged; blur = strength in percent (10-100)
// and sends { type: "ended", id, error } and, once a second, { type: "progress", id, time, duration, title }.
//
// Loaded BEFORE the YouTube IFrame API script, so onYouTubeIframeAPIReady exists when it calls it.
(function () {
  "use strict";

  const key = document.body.dataset.key || "";
  const container = document.getElementById("player-container");

  let player = null;
  let playerReady = false;
  let current = null; // the queue item now playing
  let pending = null; // arrived before the YouTube API was ready
  let wantPaused = false;
  // The cover for the clip being played. Reset when a "play" ARRIVES, not when it is carried out:
  // a play deferred until the YouTube API is ready runs after the "cover" that followed it.
  let coverMode = null;
  let ws = null;
  let reconnectAttempt = 0;

  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function show(visible) {
    container.style.display = visible ? "block" : "none";
  }

  // 100% is 80px, which leaves nothing of a 1080p frame but colour; 10% still softens faces.
  function setBlur(percent) {
    const value = Math.min(100, Math.max(10, Number(percent) || 60));
    const px = Math.round(value * 0.8);
    container.style.setProperty("--blur", `${px}px`);
    container.style.setProperty("--blur-scale", String(1 + px / 45));
  }

  function setCover(mode) {
    container.classList.remove("cover-hide", "cover-blur", "cover-image");
    if (mode === "hide" || mode === "blur" || mode === "image") container.classList.add(`cover-${mode}`);
  }

  window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player("ytplayer", {
      width: "100%",
      height: "100%",
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, rel: 0, playsinline: 1 },
      events: {
        onReady: () => {
          playerReady = true;
          if (pending) {
            const item = pending;
            pending = null;
            play(item);
          }
        },
        onStateChange: (event) => {
          if (event.data === YT.PlayerState.ENDED) finish(false);
          // A pause that arrived while the clip was still loading.
          else if (event.data === YT.PlayerState.PLAYING && wantPaused) player.pauseVideo();
        },
        // Removed, private, not embeddable: report it and let the queue move on.
        onError: () => finish(true),
      },
    });
  };

  function play(item) {
    current = item;
    wantPaused = false;
    setCover(coverMode);
    if (!item || !item.videoId) {
      finish(true);
      return;
    }
    const options = { videoId: item.videoId, startSeconds: item.start || 0 };
    if (item.end > 0) options.endSeconds = item.end;
    show(true);
    player.loadVideoById(options);
  }

  function finish(error) {
    if (!current) return;
    const id = current.id;
    current = null;
    show(false);
    send({ type: "ended", id, error: Boolean(error) });
  }

  function stop() {
    current = null;
    pending = null;
    wantPaused = false;
    show(false);
    if (playerReady) player.stopVideo();
  }

  function onMessage(msg) {
    switch (msg.type) {
      case "play":
        coverMode = null;
        setCover(null);
        if (!playerReady) pending = msg.item;
        else play(msg.item);
        break;
      case "pause":
        wantPaused = true;
        if (playerReady && current) player.pauseVideo();
        break;
      case "resume":
        wantPaused = false;
        if (playerReady && current) player.playVideo();
        break;
      case "seek":
        if (playerReady && current) player.seekTo(Number(msg.time) || 0, true);
        break;
      case "stop":
        stop();
        break;
      case "cover":
        if (msg.blur !== undefined) setBlur(msg.blur);
        coverMode = msg.mode || null;
        setCover(coverMode);
        break;
      default:
        break;
    }
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws/donation-media?key=${encodeURIComponent(key)}`);
    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
    });
    ws.addEventListener("message", (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch (_) {
        /* not ours */
      }
    });
    // The server puts an unfinished clip back at the head of the queue when the last player goes,
    // and sends it again on reconnect - so this page just stops and waits.
    ws.addEventListener("close", (event) => {
      stop();
      if (event.code === 4001) return; // the owner made new links; this one is dead
      reconnectAttempt++;
      setTimeout(connect, Math.min(1000 * Math.pow(2, reconnectAttempt), 15000));
    });
  }

  setInterval(() => {
    if (!playerReady || !current) return;
    const data = player.getVideoData ? player.getVideoData() : null;
    // While the next clip loads, the player still reports the previous one.
    if (!data || data.video_id !== current.videoId) return;
    send({
      type: "progress",
      id: current.id,
      time: player.getCurrentTime() || 0,
      duration: current.end > 0 ? current.end : player.getDuration() || 0,
      title: data.title || "",
    });
  }, 1000);

  connect();
})();
