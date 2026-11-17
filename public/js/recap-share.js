// The shareable picture of a personal year recap (views/annualRecapMe.ejs). Drawn in the browser on
// a 1080x1350 canvas from #recap-share-data - the same numbers the page shows, nothing from the
// private record - then offered as a PNG: download, the system share sheet where the browser has
// one, or the clipboard. Pictures come through the site's /recap/img, same-origin, because a canvas
// that drew a cross-origin picture without CORS refuses to export.
(function () {
  "use strict";

  const block = document.querySelector("[data-recap-share]");
  const dataEl = document.getElementById("recap-share-data");
  if (!block || !dataEl || !HTMLCanvasElement.prototype.toBlob) return;
  let data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (e) {
    return;
  }
  if (!data) return;
  block.hidden = false;

  const W = 1080;
  const H = 1350;
  const L = data.labels || {};
  const lang = document.documentElement.lang || undefined;
  const fmt = (n) => Number(n || 0).toLocaleString(lang);
  const font = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
  const F = (weight, size) => weight + " " + size + "px " + font;

  function loadImage(src) {
    return new Promise(function (resolve) {
      if (!src) return resolve(null);
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  // The largest size (down from `size`) at which `text` fits `maxWidth`, then draws it.
  function fitText(ctx, text, x, y, maxWidth, size, weight, minSize) {
    let s = size;
    ctx.font = F(weight, s);
    while (s > (minSize || 18) && ctx.measureText(text).width > maxWidth) {
      s -= 2;
      ctx.font = F(weight, s);
    }
    let out = text;
    if (ctx.measureText(out).width > maxWidth) {
      while (out.length > 1 && ctx.measureText(out + "…").width > maxWidth) out = out.slice(0, -1);
      out += "…";
    }
    ctx.fillText(out, x, y);
    return s;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function circleImage(ctx, img, cx, cy, r, ring) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = "#262626";
    ctx.fill();
    if (img) {
      ctx.clip();
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    }
    ctx.restore();
    if (ring) {
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = ring;
      ctx.lineWidth = 6;
      ctx.stroke();
    }
  }

  function containImage(ctx, img, x, y, maxW, maxH) {
    const k = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * k;
    const h = img.height * k;
    ctx.drawImage(img, x + (maxW - w) / 2, y + (maxH - h) / 2, w, h);
  }

  // The peak hour on the reader's clock (stored on the Moscow one, UTC+3).
  function localPeak() {
    const minutes = ((((data.peakHourMsk * 60) + (-new Date().getTimezoneOffset() - 180)) % 1440) + 1440) % 1440;
    return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
  }

  function panel(ctx, x, y, w, h) {
    roundRect(ctx, x, y, w, h, 36);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function label(ctx, text, x, y) {
    ctx.font = F(700, 24);
    ctx.fillStyle = "#d8b4fe";
    ctx.fillText(String(text || "").toUpperCase(), x, y);
  }

  async function draw() {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "alphabetic";

    // background: the recap's own night-purple with an amber glow
    ctx.fillStyle = "#0f0b16";
    ctx.fillRect(0, 0, W, H);
    [["rgba(126,34,206,0.60)", 0, 0, 900], ["rgba(219,39,119,0.30)", W, H, 900], ["rgba(251,191,36,0.14)", W * 0.85, 120, 500]].forEach(function (g) {
      const grad = ctx.createRadialGradient(g[1], g[2], 0, g[1], g[2], g[3]);
      grad.addColorStop(0, g[0]);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    });

    const [chanImg, userImg, partnerImg, ...emoteImgs] = await Promise.all([
      loadImage(data.channel && data.channel.avatar),
      loadImage(data.user && data.user.avatar),
      loadImage(data.partner && data.partner.avatar),
    ].concat((data.emotes || []).map(function (e) { return loadImage(e.url); })));

    // header: the channel
    circleImage(ctx, chanImg, 96, 96, 36, null);
    ctx.fillStyle = "#e9d5ff";
    fitText(ctx, L.kicker + " · " + data.channel.login, 150, 108, W - 220, 34, 700, 22);

    // the person, and the year
    circleImage(ctx, userImg, 200, 330, 120, "#fcd34d");
    ctx.fillStyle = (data.user && data.user.color) || "#ffffff";
    fitText(ctx, data.user.name, 360, 300, W - 420, 72, 800, 36);
    const yearGrad = ctx.createLinearGradient(360, 0, 900, 0);
    yearGrad.addColorStop(0, "#d8b4fe");
    yearGrad.addColorStop(0.5, "#f472b6");
    yearGrad.addColorStop(1, "#fcd34d");
    ctx.fillStyle = yearGrad;
    ctx.font = F(900, 150);
    ctx.fillText(String(data.year), 352, 450);

    // three numbers
    const tiles = [
      [L.messages, fmt(data.messages)],
      [L.streams, fmt(data.streams.attended) + " / " + fmt(data.streams.of)],
      [L.rank, "#" + fmt(data.rank) + " " + L.rankOf + " " + fmt(data.of)],
    ];
    const tw = (W - 96 * 2 - 24 * 2) / 3;
    tiles.forEach(function (tile, i) {
      const x = 96 + i * (tw + 24);
      panel(ctx, x, 540, tw, 190);
      label(ctx, tile[0], x + 28, 592);
      ctx.fillStyle = "#ffffff";
      fitText(ctx, tile[1], x + 28, 690, tw - 56, 64, 800, 28);
    });

    // emote and word
    const half = (W - 96 * 2 - 24) / 2;
    panel(ctx, 96, 760, half, 300);
    label(ctx, L.emote, 124, 812);
    const top = (data.emotes || [])[0];
    if (top) {
      if (emoteImgs[0]) containImage(ctx, emoteImgs[0], 124, 840, 150, 150);
      ctx.fillStyle = "#ffffff";
      fitText(ctx, top.name, emoteImgs[0] ? 296 : 124, 920, half - (emoteImgs[0] ? 228 : 56), 44, 800, 22);
      ctx.fillStyle = "#fcd34d";
      ctx.font = F(700, 30);
      ctx.fillText(fmt(top.n) + " " + L.times, emoteImgs[0] ? 296 : 124, 970);
      // the next two, small
      (data.emotes || []).slice(1, 3).forEach(function (e, k) {
        const img = emoteImgs[k + 1];
        if (img) containImage(ctx, img, 124 + k * 70, 1000, 52, 52);
      });
    }

    panel(ctx, 96 + half + 24, 760, half, 300);
    const wx = 96 + half + 52;
    label(ctx, L.word, wx, 812);
    if (data.word) {
      ctx.fillStyle = "#ffffff";
      fitText(ctx, data.word.text, wx, 930, half - 56, 96, 900, 30);
      ctx.fillStyle = "#fcd34d";
      ctx.font = F(700, 30);
      ctx.fillText(fmt(data.word.n) + " " + L.times, wx, 990);
    }

    // partner, peak hour, days
    panel(ctx, 96, 1090, W - 192, 150);
    let x = 128;
    if (data.partner) {
      label(ctx, L.partner, x, 1140);
      circleImage(ctx, partnerImg, x + 34, 1190, 30, null);
      ctx.fillStyle = "#ffffff";
      fitText(ctx, data.partner.name, x + 80, 1202, 300, 36, 800, 20);
      x += 440;
    }
    label(ctx, L.peak, x, 1140);
    ctx.fillStyle = "#fcd34d";
    ctx.font = F(800, 48);
    ctx.fillText(localPeak(), x, 1208);
    x += 230;
    label(ctx, L.days, x, 1140);
    ctx.fillStyle = "#ffffff";
    ctx.font = F(800, 48);
    ctx.fillText(fmt(data.activeDays), x, 1208);

    // footer
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = F(600, 26);
    ctx.fillText(location.host + "/" + data.channel.login + "/recap", 96, 1300);
    ctx.textAlign = "right";
    ctx.fillText(L.footer, W - 96, 1300);
    ctx.textAlign = "left";

    return new Promise(function (resolve) { canvas.toBlob(resolve, "image/png"); });
  }

  const openBtn = block.querySelector("[data-share-open]");
  const result = block.querySelector("[data-share-result]");
  const preview = block.querySelector("[data-share-preview]");
  const download = block.querySelector("[data-share-download]");
  const nativeBtn = block.querySelector("[data-share-native]");
  const copyBtn = block.querySelector("[data-share-copy]");
  const errorEl = block.querySelector("[data-share-error]");
  let blob = null;

  openBtn.addEventListener("click", async function () {
    openBtn.disabled = true;
    errorEl.classList.add("hidden");
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      blob = await draw();
      if (!blob) throw new Error("no blob");
      const url = URL.createObjectURL(blob);
      preview.src = url;
      download.href = url;
      const file = new File([blob], download.getAttribute("download"), { type: "image/png" });
      nativeBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
      copyBtn.hidden = !(navigator.clipboard && window.ClipboardItem);
      result.classList.remove("hidden");
      nativeBtn.onclick = function () {
        navigator.share({ files: [file], title: L.kicker }).catch(function () {});
      };
      copyBtn.onclick = function () {
        navigator.clipboard
          .write([new ClipboardItem({ "image/png": blob })])
          .then(function () { copyBtn.textContent = copyBtn.dataset.done; })
          .catch(function () {});
      };
    } catch (e) {
      errorEl.classList.remove("hidden");
    } finally {
      openBtn.disabled = false;
    }
  });
})();
