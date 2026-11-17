// The year recap's clock in the reader's own time zone (views/annualRecap.ejs, annualRecapMe.ejs).
//
// The recap stores hours on the Moscow clock (UTC+3, lib/annualRecap.js's TZ_OFFSET_MS), and the
// server cannot know where a reader is. The browser does: this turns
//   [data-tz-hours]   - the 24-bar chart: each hour moved by the difference, peak and title redone,
//                       the label under it set to the reader's UTC offset;
//   [data-local-time] - a <time datetime> written in Moscow time, re-written in local time;
//   [data-msk-hour]   - an "HH:00" written on the Moscow clock.
// A zone off by a fraction of an hour (India, +5:30) cannot move whole hour bars, so the chart keeps
// its Moscow label there; single times are still converted. Without JS the page says UTC+3.
(function () {
  "use strict";

  const MSK_MINUTES = 180;
  const local = -new Date().getTimezoneOffset();
  const lang = document.documentElement.lang || undefined;
  const fmtNum = (n) => Number(n).toLocaleString(lang);
  const pad = (h) => String(h).padStart(2, "0");

  function utcLabel(minutes) {
    const sign = minutes < 0 ? "−" : "+";
    const abs = Math.abs(minutes);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return "UTC" + sign + h + (m ? ":" + pad(m) : "");
  }

  const shiftMinutes = local - MSK_MINUTES;

  document.querySelectorAll("[data-tz-hours]").forEach(function (box) {
    if (shiftMinutes % 60 !== 0) return;
    const label = box.querySelector("[data-tz-label]");
    if (label && label.dataset.localLabel) label.textContent = label.dataset.localLabel.replace("{tz}", utcLabel(local));
    if (shiftMinutes === 0) return;
    let hours;
    try {
      hours = JSON.parse(box.dataset.tzHours);
    } catch (e) {
      return;
    }
    if (!Array.isArray(hours) || hours.length !== 24) return;
    const shift = shiftMinutes / 60;
    const turned = new Array(24).fill(0);
    hours.forEach(function (n, h) { turned[(((h + shift) % 24) + 24) % 24] = n; });
    const max = Math.max(1, ...turned);
    const peak = turned.indexOf(Math.max(...turned));
    box.querySelectorAll("[data-tz-bar]").forEach(function (bar, h) {
      const n = turned[h];
      bar.style.height = Math.max(2, Math.round((n / max) * 100)) + "%";
      bar.classList.toggle("recap-bar-peak", h === peak);
      bar.style.background = h === peak ? "" : "rgb(192 132 252 / " + (0.18 + 0.62 * n / max).toFixed(2) + ")";
      bar.title = pad(h) + ":00 — " + fmtNum(n);
    });
    const peakEl = box.querySelector("[data-tz-peak]");
    if (peakEl) peakEl.textContent = pad(peak) + ":00";
  });

  document.querySelectorAll("time[data-local-time]").forEach(function (el) {
    const at = new Date(el.getAttribute("datetime"));
    if (Number.isNaN(at.getTime())) return;
    el.textContent = at.toLocaleString(lang, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  });

  document.querySelectorAll("[data-msk-hour]").forEach(function (el) {
    const h = Number(el.dataset.mskHour);
    if (!Number.isInteger(h)) return;
    const minutes = (((h * 60 + shiftMinutes) % 1440) + 1440) % 1440;
    el.textContent = pad(Math.floor(minutes / 60)) + ":" + pad(minutes % 60) + " (" + utcLabel(local) + ")";
  });
})();
