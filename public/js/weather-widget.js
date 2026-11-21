// The OBS weather widget (views/weatherWidget.ejs, routes/widgets.js).
//
// The scene is a stack of layers, and a weather code is a set of strengths for them
// (lib/weatherWidget.js's SCENES, handed over in data-bootstrap). Changing the weather means
// easing every layer from its old strength to its new one, in an order that reads as weather
// rather than as a cross-fade: when it gets worse the clouds roll in first, the sky darkens under
// them and only then the rain or snow starts; when it clears the rain stops first, then the
// clouds drift off and the sun comes out. With transitions off the same strengths are applied at
// once.
//
// The page polls its own server (never the weather service) every POLL_MS. The setup page frames
// this page and drives it with postMessage: a preview condition, the live reading back, and the
// form's look before it is saved. Only messages from this origin are honoured.
(function () {
  "use strict";

  var POLL_MS = 5 * 60 * 1000;
  var RETRY_MS = 60 * 1000;
  // How long a change of weather takes to play out, and how the layers overlap inside it.
  var CHANGE_MS = 2600;
  // Each cloud slot appears once cover passes its threshold; the higher slots fill the sky.
  var CLOUD_SLOTS = [
    { threshold: 0.12, side: 1 },
    { threshold: 0.35, side: -1 },
    { threshold: 0.6, side: 1 },
    { threshold: 0.85, side: -1 },
  ];

  var body = document.body;
  var boot;
  try {
    boot = JSON.parse(body.dataset.bootstrap || "{}");
  } catch (_) {
    boot = {};
  }
  var key = body.dataset.key;
  var scenes = boot.scenes || {};
  var descriptions = boot.descriptions || {};
  var strings = boot.strings || {};

  var widget = document.getElementById("widget");
  var sceneEl = document.getElementById("scene");
  var tempEl = document.getElementById("temp");
  var unitEl = document.getElementById("unit");
  var descEl = document.getElementById("desc");
  var cityEl = document.getElementById("city");
  var detailsEl = document.getElementById("details");
  var q = function (sel) {
    return sceneEl.querySelector(sel);
  };
  var layers = {
    skyDay: q(".sky-day"),
    skyNight: q(".sky-night"),
    skyOvercast: q(".sky-overcast"),
    skyStorm: q(".sky-storm"),
    stars: q(".stars"),
    sun: q(".sun"),
    moon: q(".moon"),
    clouds: Array.prototype.slice.call(sceneEl.querySelectorAll(".cloud")),
    fog: Array.prototype.slice.call(sceneEl.querySelectorAll(".fog")),
  };

  var settings = Object.assign({ style: "realistic", animations: true, transitions: true, units: "c", transparent: false }, boot.settings || {});
  var city = boot.city || "";
  var live = null; // the last reading from the server: { reading, error }
  var previewing = false;
  var shown = null; // the state on screen: { scene, night }
  var shownReading = null;
  var FIELDS = ["icon", "temp", "desc", "city", "feels", "wind", "humidity"];
  var DETAIL_FIELDS = ["feels", "wind", "humidity"];

  function visible(field) {
    var show = settings.show || {};
    return show[field] !== false;
  }

  // --- settings --------------------------------------------------------------------------------

  function applySettings(next) {
    var before = settings;
    settings = Object.assign({}, settings, next || {});
    body.classList.toggle("style-minimal", settings.style === "minimal");
    body.classList.toggle("style-realistic", settings.style !== "minimal");
    body.classList.toggle("anim-on", !!settings.animations);
    body.classList.toggle("bg-none", !!settings.transparent);
    var iconBefore = !before.show || before.show.icon !== false;
    layout();
    if (before.style !== settings.style || before.animations !== settings.animations || iconBefore !== visible("icon")) precip.restyle();
    if (shownReading) renderText(shownReading, false);
    scheduleStrike();
  }

  // Lays the widget out from the fields that are on. Whatever comes first of temperature,
  // description, city and details becomes the large line, so a widget showing only the
  // description or only the city is a headline, not a caption left alone in a card; with no text
  // at all the card shrinks around the picture, and with no picture around the text. A message
  // (no city, weather unavailable) is shown in the description line even when that line is off -
  // it is the one thing the streamer must see.
  function layout(forceDesc) {
    FIELDS.forEach(function (f) {
      body.classList.toggle("hide-" + f, !visible(f) && !(f === "desc" && forceDesc));
    });
    var details = DETAIL_FIELDS.some(visible);
    body.classList.toggle("hide-details", !details);
    var order = [["temp", visible("temp")], ["desc", visible("desc") || !!forceDesc], ["city", visible("city")], ["details", details]];
    var lead = null;
    for (var i = 0; i < order.length; i++) {
      if (order[i][1]) {
        lead = order[i][0];
        break;
      }
    }
    ["temp", "desc", "city", "details"].forEach(function (k) {
      body.classList.toggle("lead-" + k, lead === k);
    });
    body.classList.toggle("no-info", !lead);
    body.classList.toggle("text-only", !!lead && !visible("icon"));
  }

  // --- scene -----------------------------------------------------------------------------------

  function setLayer(el, props, delayMs, durationMs) {
    if (!el) return;
    el.style.transitionDelay = (delayMs || 0) + "ms";
    el.style.transitionDuration = (durationMs || 0) + "ms";
    if (props.opacity !== undefined) el.style.opacity = String(props.opacity);
    if (props.transform !== undefined) el.style.transform = props.transform;
    if (props.filter !== undefined) el.style.filter = props.filter;
  }

  function clamp01(n) {
    return Math.max(0, Math.min(1, Number(n) || 0));
  }

  // Puts `scene` (a SCENES entry) on screen; `night` swaps the sun for the moon and the day sky
  // for the night one. `animate` false applies it in one frame.
  function showScene(scene, night, animate) {
    var prev = shown ? shown.scene : null;
    var D = animate ? CHANGE_MS : 0;
    var worse = !prev || scene.clouds > prev.clouds + 0.02 || scene.rain + scene.snow > prev.rain + prev.snow + 0.02 || scene.dark > prev.dark + 0.05;

    // Timings, as fractions of D: worse - sky and clouds first, precipitation last; better -
    // precipitation stops first, clouds leave, the sun comes back last.
    var t = worse
      ? { clouds: 0, sky: 0.1, sun: 0.25, precip: 0.55, precipDur: 0.45, fog: 0.2 }
      : { clouds: 0.3, sky: 0.35, sun: 0.55, precip: 0, precipDur: 0.35, fog: 0.25 };
    var dur = 0.6 * D;

    var dark = clamp01(scene.dark);
    var cover = clamp01(scene.clouds);
    var n = night ? 1 : 0;

    setLayer(layers.skyNight, { opacity: n }, t.sky * D, dur);
    setLayer(layers.skyOvercast, { opacity: cover * 0.85 * (night ? 0.3 : 1) }, t.sky * D, dur);
    setLayer(layers.skyStorm, { opacity: dark * cover * (night ? 0.7 : 0.95) }, t.sky * D, dur);
    setLayer(layers.stars, { opacity: n * (1 - cover * 0.9) }, t.sky * D, dur);

    // The sun (or moon) sinks a little as it fades, so it reads as going behind the clouds.
    var sunShow = clamp01(scene.sun);
    var bodyTransform = function (v) {
      return "translateY(" + ((1 - v) * 14).toFixed(1) + "%) scale(" + (0.82 + 0.18 * v).toFixed(3) + ")";
    };
    var sunV = night ? 0 : sunShow;
    var moonV = night ? sunShow : 0;
    setLayer(layers.sun, { opacity: sunV, transform: bodyTransform(sunV) }, t.sun * D, dur);
    setLayer(layers.moon, { opacity: moonV, transform: bodyTransform(moonV) }, t.sun * D, dur);

    var brightness = (1 - dark * 0.55) * (night ? 0.72 : 1);
    // Off-sky clouds wait past the box's edge in the realistic look (the box clips them); without
    // a box - the minimal look, or a transparent background - a cloud only drifts a little as it
    // fades, since a full slide would carry it across the temperature.
    var travel = settings.style === "minimal" || settings.transparent ? 30 : 140;
    layers.clouds.forEach(function (el, i) {
      var slot = CLOUD_SLOTS[i];
      var on = cover >= slot.threshold;
      var stagger = (worse ? i : CLOUD_SLOTS.length - 1 - i) * 0.07 * D;
      setLayer(
        el,
        {
          opacity: on ? 1 : 0,
          transform: on ? "translateX(0)" : "translateX(" + slot.side * travel + "%)",
          filter: "brightness(" + brightness.toFixed(3) + ")",
        },
        t.clouds * D + stagger,
        dur
      );
    });

    layers.fog.forEach(function (el, i) {
      setLayer(el, { opacity: clamp01(scene.fog) * (0.9 - i * 0.12) }, t.fog * D + i * 120, dur);
    });

    precip.set({ rain: clamp01(scene.rain), snow: clamp01(scene.snow) }, t.precip * D, t.precipDur * D);

    // Lightning joins once the storm clouds are in, and leaves with the rain.
    clearTimeout(showScene.stormTimer);
    var stormOn = !!scene.storm;
    if (stormOn) {
      showScene.stormTimer = setTimeout(function () {
        sceneEl.classList.add("storm");
        scheduleStrike(true);
      }, worse ? 0.7 * D : 0);
    } else {
      sceneEl.classList.remove("storm");
      scheduleStrike();
    }

    shown = { scene: scene, night: night };
  }

  var strikeTimer = null;
  function scheduleStrike(soon) {
    clearTimeout(strikeTimer);
    if (!settings.animations || !sceneEl.classList.contains("storm")) return;
    var wait = soon ? 400 + Math.random() * 1200 : 3500 + Math.random() * 6000;
    strikeTimer = setTimeout(function () {
      sceneEl.classList.remove("strike");
      // Restarting the keyframes needs a reflow between removing and adding the class.
      void sceneEl.offsetWidth;
      sceneEl.classList.add("strike");
      // Now and then a second strike right behind the first.
      if (Math.random() < 0.3) {
        setTimeout(function () {
          sceneEl.classList.remove("strike");
          void sceneEl.offsetWidth;
          sceneEl.classList.add("strike");
        }, 900);
      }
      scheduleStrike();
    }, wait);
  }

  // --- rain and snow ---------------------------------------------------------------------------

  var precip = (function () {
    var canvas = document.getElementById("precip");
    var ctx = canvas.getContext("2d");
    var W = 0;
    var H = 0;
    var dpr = 1;
    var MAX_RAIN = 150;
    var MAX_SNOW = 90;
    var rain = [];
    var snow = [];
    var splashes = [];
    var level = { rain: 0, snow: 0 };
    var target = { rain: 0, snow: 0 };
    // The last non-zero target of each kind. When a kind is switched off, what is still in the air
    // fades with the level instead of finishing its fall - snow takes seconds to reach the ground,
    // and flakes drifting over a sky that has just cleared read as a bug, not as weather.
    var peak = { rain: 0, snow: 0 };
    var ramp = { start: 0, from: { rain: 0, snow: 0 }, duration: 1 };
    var running = false;
    var last = 0;

    function minimal() {
      return settings.style === "minimal";
    }

    // Where precipitation lives. It is drawn over the clouds and starts at their belly - in the
    // realistic look the clouds fill most of the box, and anything falling behind them is hidden
    // until the last third. In the minimal one it is a column under the outline, like an icon.
    function bounds() {
      return minimal() ? { top: H * 0.7, bottom: H * 1.02, left: W * 0.16, right: W * 0.9 } : { top: H * 0.42, bottom: H, left: -W * 0.1, right: W * 1.05 };
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = Math.max(1, Math.round(rect.width * dpr));
      H = Math.max(1, Math.round(rect.height * dpr));
      canvas.width = W;
      canvas.height = H;
    }

    function newDrop(d, scatter) {
      var b = bounds();
      d.x = b.left + Math.random() * (b.right - b.left);
      d.y = scatter ? b.top + Math.random() * (b.bottom - b.top) : b.top - Math.random() * H * 0.25;
      d.v = H * (1.5 + Math.random() * 0.7); // px per second
      d.len = H * (minimal() ? 0.06 + Math.random() * 0.03 : 0.07 + Math.random() * 0.07);
      d.alpha = 0.45 + Math.random() * 0.5;
      d.live = true;
      return d;
    }

    function newFlake(f, scatter) {
      var b = bounds();
      f.x = b.left + Math.random() * (b.right - b.left);
      f.y = scatter ? b.top + Math.random() * (b.bottom - b.top) : b.top - Math.random() * H * 0.08;
      f.v = H * (0.16 + Math.random() * 0.18);
      f.r = (minimal() ? 2.2 : 1.4 + Math.random() * 2.2) * dpr;
      f.phase = Math.random() * Math.PI * 2;
      f.sway = W * (0.01 + Math.random() * 0.02);
      f.freq = 0.8 + Math.random() * 1.2;
      f.live = true;
      return f;
    }

    function fill(pool, max, make) {
      while (pool.length < max) pool.push(make({}, true));
      for (var i = 0; i < pool.length; i++) pool[i].live = false;
    }

    function wanted(kind) {
      return Math.round(level[kind] * (kind === "rain" ? MAX_RAIN : MAX_SNOW) * (minimal() ? 0.35 : 1));
    }

    function updateLevel(now) {
      var k = ramp.duration > 0 ? Math.max(0, Math.min(1, (now - ramp.start) / ramp.duration)) : 1;
      if (now < ramp.start) k = 0;
      level.rain = ramp.from.rain + (target.rain - ramp.from.rain) * k;
      level.snow = ramp.from.snow + (target.snow - ramp.from.snow) * k;
    }

    function step(dt, t) {
      var b = bounds();
      var slant = minimal() ? 0.08 : 0.17;
      var wantRain = wanted("rain");
      var wantSnow = wanted("snow");
      for (var i = 0; i < rain.length; i++) {
        var d = rain[i];
        if (!d.live) {
          if (i < wantRain) newDrop(d, false);
          continue;
        }
        d.y += d.v * dt;
        d.x -= d.v * slant * dt;
        if (d.y - d.len > b.bottom) {
          if (!minimal() && Math.random() < 0.5) splash(d.x, b.bottom - 2 * dpr);
          if (i < wantRain) newDrop(d, false);
          else d.live = false;
        }
      }
      for (var j = 0; j < snow.length; j++) {
        var f = snow[j];
        if (!f.live) {
          if (j < wantSnow) newFlake(f, false);
          continue;
        }
        f.y += f.v * dt;
        f.x += Math.sin(t * f.freq + f.phase) * f.sway * dt;
        if (f.y - f.r > b.bottom) {
          if (j < wantSnow) newFlake(f, false);
          else f.live = false;
        }
      }
      for (var s = splashes.length - 1; s >= 0; s--) {
        var p = splashes[s];
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += H * 3 * dt;
        if (p.life <= 0) splashes.splice(s, 1);
      }
    }

    function splash(x, y) {
      for (var k = 0; k < 2; k++) {
        splashes.push({ x: x, y: y, vx: (Math.random() - 0.5) * H * 0.4, vy: -H * (0.25 + Math.random() * 0.3), life: 0.25 });
      }
    }

    // Particles emerge softly from the cloud's belly instead of popping out of a hard line; in the
    // minimal look they also thin out towards the bottom of their column.
    function fadeAt(y, b) {
      var k = (y - b.top) / (b.bottom - b.top);
      var emerge = Math.max(0, Math.min(1, k / 0.18));
      return minimal() ? emerge * Math.max(0, Math.min(1, 1.2 - k)) : emerge;
    }

    function fade(kind) {
      if (target[kind] > 0) return 1;
      return peak[kind] > 0 ? Math.max(0, Math.min(1, level[kind] / peak[kind])) : 0;
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      var rainFade = fade("rain");
      var snowFade = fade("snow");
      var b = bounds();
      var slant = minimal() ? 0.08 : 0.17;
      ctx.lineCap = "round";
      for (var i = 0; i < rain.length; i++) {
        var d = rain[i];
        if (!d.live) continue;
        var x2 = d.x + d.len * slant;
        var y2 = d.y - d.len;
        if (minimal()) {
          ctx.strokeStyle = "rgba(140, 200, 255," + (0.95 * fadeAt(d.y, b) * rainFade).toFixed(3) + ")";
          ctx.lineWidth = 2.4 * dpr;
        } else {
          var g = ctx.createLinearGradient(x2, y2, d.x, d.y);
          g.addColorStop(0, "rgba(200, 225, 255, 0)");
          g.addColorStop(1, "rgba(210, 232, 255," + (d.alpha * rainFade * fadeAt(d.y, b)).toFixed(3) + ")");
          ctx.strokeStyle = g;
          ctx.lineWidth = 1.3 * dpr;
        }
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(d.x, d.y);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(220, 235, 255," + (0.7 * rainFade).toFixed(3) + ")";
      for (var s = 0; s < splashes.length; s++) {
        var p = splashes[s];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 0.9 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      // A soft dark edge keeps a white flake visible over white clouds.
      if (!minimal()) {
        ctx.shadowColor = "rgba(40, 50, 70, " + (0.6 * snowFade).toFixed(3) + ")";
        ctx.shadowBlur = 3 * dpr;
      }
      for (var j = 0; j < snow.length; j++) {
        var f = snow[j];
        if (!f.live) continue;
        if (minimal()) {
          ctx.fillStyle = "rgba(255, 255, 255," + (0.95 * fadeAt(f.y, b) * snowFade).toFixed(3) + ")";
          ctx.beginPath();
          ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          var a = snowFade * fadeAt(f.y, b);
          var rg = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 1.6);
          rg.addColorStop(0, "rgba(255, 255, 255," + (0.98 * a).toFixed(3) + ")");
          rg.addColorStop(0.55, "rgba(245, 248, 255," + (0.75 * a).toFixed(3) + ")");
          rg.addColorStop(1, "rgba(255, 255, 255, 0)");
          ctx.fillStyle = rg;
          ctx.beginPath();
          ctx.arc(f.x, f.y, f.r * 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
    }

    function frame(now) {
      if (!running) return;
      // Speeds are per second, so a slow machine (or OBS rendering the source at a low frame
      // rate) shows the same weather with fewer frames rather than in slow motion. The cap only
      // stops a long stall - a hidden scene - from flinging everything past the ground at once.
      var dt = Math.min(0.25, (now - last) / 1000 || 0);
      last = now;
      updateLevel(performance.now());
      if (target.rain === 0 && level.rain === 0) killAll(rain);
      if (target.snow === 0 && level.snow === 0) killAll(snow);
      step(dt, now / 1000);
      draw();
      var idle = level.rain === 0 && level.snow === 0 && target.rain === 0 && target.snow === 0 && !rain.some(isLive) && !snow.some(isLive);
      if (idle) {
        running = false;
        ctx.clearRect(0, 0, W, H);
        return;
      }
      requestAnimationFrame(frame);
    }

    function killAll(pool) {
      for (var i = 0; i < pool.length; i++) pool[i].live = false;
    }

    function isLive(p) {
      return p.live;
    }

    function start() {
      if (running) return;
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    }

    // With motion off: one still frame of the target intensity, scattered over the column.
    function still() {
      running = false;
      level.rain = target.rain;
      level.snow = target.snow;
      var wr = wanted("rain");
      var ws = wanted("snow");
      rain.forEach(function (d, i) {
        if (i < wr) newDrop(d, true);
        else d.live = false;
      });
      snow.forEach(function (f, i) {
        if (i < ws) newFlake(f, true);
        else f.live = false;
      });
      splashes.length = 0;
      draw();
    }

    resize();
    fill(rain, MAX_RAIN, newDrop);
    fill(snow, MAX_SNOW, newFlake);
    window.addEventListener("resize", function () {
      resize();
      restyle();
    });

    function set(next, delayMs, durationMs) {
      var now = performance.now();
      updateLevel(now);
      ramp = { start: now + (delayMs || 0), from: { rain: level.rain, snow: level.snow }, duration: durationMs || 0 };
      target = { rain: next.rain, snow: next.snow };
      if (next.rain > 0) peak.rain = next.rain;
      else if (level.rain > 0) peak.rain = level.rain;
      if (next.snow > 0) peak.snow = next.snow;
      else if (level.snow > 0) peak.snow = level.snow;
      if (!settings.animations) {
        // Nothing moves, so there is nothing to ease: show where it ends.
        setTimeout(still, durationMs ? delayMs : 0);
        return;
      }
      start();
    }

    // A change of look or of motion: drop what is in flight and redraw from the target.
    function restyle() {
      // The picture may just have been switched back on: a hidden canvas measured 0x0.
      resize();
      rain.forEach(function (d) {
        d.live = false;
      });
      snow.forEach(function (f) {
        f.live = false;
      });
      splashes.length = 0;
      ramp = { start: 0, from: { rain: target.rain, snow: target.snow }, duration: 0 };
      if (settings.animations) {
        // Scatter the first wave so the column is full immediately rather than filling from the top.
        level.rain = target.rain;
        level.snow = target.snow;
        var wr = wanted("rain");
        var ws = wanted("snow");
        rain.forEach(function (d, i) {
          if (i < wr) newDrop(d, true);
        });
        snow.forEach(function (f, i) {
          if (i < ws) newFlake(f, true);
        });
        start();
      } else {
        still();
      }
    }

    return { set: set, restyle: restyle };
  })();

  // --- text ------------------------------------------------------------------------------------

  var tempAnim = null;
  function countTo(to, animate) {
    cancelAnimationFrame(tempAnim);
    var from = parseInt(tempEl.textContent, 10);
    if (!animate || !Number.isFinite(from) || from === to) {
      tempEl.textContent = String(to);
      return;
    }
    var start = performance.now();
    var dur = 1200;
    var tick = function (now) {
      var k = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - k, 3);
      tempEl.textContent = String(Math.round(from + (to - from) * eased));
      if (k < 1) tempAnim = requestAnimationFrame(tick);
    };
    tempAnim = requestAnimationFrame(tick);
  }

  function setDesc(text, animate) {
    if (descEl.textContent === text) return;
    if (!animate) {
      descEl.textContent = text;
      return;
    }
    descEl.classList.add("is-fading");
    setTimeout(function () {
      descEl.textContent = text;
      descEl.classList.remove("is-fading");
    }, 450);
  }

  function renderText(reading, animate) {
    if (reading.temp === null || reading.temp === undefined) tempEl.textContent = "--";
    else countTo(reading.temp, animate);
    unitEl.textContent = settings.units === "f" ? "F" : "C";
    setDesc(reading.text || descriptions[reading.code] || "", animate);
    cityEl.textContent = reading.city !== undefined ? reading.city : city;
    layout(!!reading.text);
    detailsEl.textContent = "";
    var parts = [];
    if (visible("feels") && reading.feels !== null && reading.feels !== undefined) parts.push(strings.feels + " " + reading.feels + "°");
    if (visible("wind") && reading.wind !== null && reading.wind !== undefined) parts.push(strings.wind + " " + reading.wind + " " + (settings.units === "f" ? strings.windUnitF : strings.windUnitC));
    if (visible("humidity") && reading.humidity !== null && reading.humidity !== undefined) parts.push(strings.humidity + " " + reading.humidity + "%");
    parts.forEach(function (p) {
      var span = document.createElement("span");
      span.textContent = p;
      detailsEl.appendChild(span);
    });
  }

  // --- putting a reading on screen -------------------------------------------------------------

  function show(reading) {
    var first = !shown;
    var animate = !first && !!settings.transitions;
    var scene = reading.code !== null && reading.code !== undefined ? scenes[reading.code] || scenes[3] : scenes[3];
    var night = reading.isDay === false;
    if (!first && shown.scene === scene && shown.night === night) {
      renderText(reading, animate);
    } else {
      showScene(scene, night, animate);
      renderText(reading, animate);
    }
    shownReading = reading;
    widget.classList.remove("is-hidden");
  }

  // What the server's answer turns into on screen. No city or no reading still shows the widget,
  // with a line saying why - an empty source in OBS gives the streamer nothing to go on.
  function showLive() {
    if (!live) return;
    if (live.reading) {
      show(Object.assign({ city: city }, live.reading));
      return;
    }
    var text = live.error === "noCity" ? strings.noCity : strings.unavailable;
    show({ code: 3, isDay: true, temp: null, feels: null, wind: null, humidity: null, text: text, city: city });
  }

  function poll() {
    fetch("/obs/weather/" + encodeURIComponent(key) + "/data", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.settings) applySettings(data.settings);
        if (typeof data.city === "string") city = data.city;
        live = { reading: data.reading || null, error: data.error || null };
        if (!previewing) showLive();
        setTimeout(poll, data.reading ? POLL_MS : RETRY_MS);
      })
      .catch(function () {
        // The server is down or the key was replaced: keep what is on screen and try again.
        setTimeout(poll, RETRY_MS);
      });
  }

  // --- the setup page's preview ----------------------------------------------------------------

  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin) return;
    var msg = event.data || {};
    if (msg.type === "weather-preview") {
      previewing = true;
      var code = Number(msg.code);
      show({
        code: code,
        isDay: msg.isDay !== false,
        temp: Number.isFinite(Number(msg.temp)) ? Number(msg.temp) : 20,
        feels: Number.isFinite(Number(msg.temp)) ? Number(msg.temp) - 2 : null,
        wind: 12,
        humidity: 64,
        city: city,
      });
    } else if (msg.type === "weather-live") {
      previewing = false;
      showLive();
    } else if (msg.type === "weather-settings") {
      applySettings(msg.settings || {});
    } else if (msg.type === "weather-city") {
      city = String(msg.city || "");
      if (shownReading) {
        shownReading.city = city;
        cityEl.textContent = city;
      }
    }
  });

  applySettings(settings);
  poll();
})();
