// The weather widget setup page (views/weatherWidgetSetup.ejs): the city search and the live
// preview. The preview frame is the real OBS page (public/js/weather-widget.js); this script only
// sends it messages - a condition to show, the form's look before it is saved, back to the live
// reading. Without JS the form still works: the server looks the typed city up itself.
(function () {
  "use strict";

  var form = document.getElementById("weather-form");
  var frame = document.getElementById("weather-preview");
  if (!form) return;

  function post(message) {
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(message, window.location.origin);
  }

  // --- the look, previewed before saving -------------------------------------------------------

  // The same rule as the server's (lib/weatherWidget.js's parseShow): nothing ticked previews as
  // the picture and the temperature, which is what saving it would store.
  var FIELDS = ["icon", "temp", "desc", "city", "feels", "wind", "humidity"];
  function show(checked) {
    var out = {};
    var any = false;
    FIELDS.forEach(function (f) {
      out[f] = checked("show_" + f);
      any = any || out[f];
    });
    if (!any) {
      FIELDS.forEach(function (f) {
        out[f] = f === "icon" || f === "temp";
      });
    }
    return out;
  }

  function value(name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el ? el.value : undefined;
  }

  function freeLayout() {
    try {
      return JSON.parse(value("free") || "{}");
    } catch (_) {
      return {};
    }
  }

  function formSettings() {
    var checked = function (name) {
      var el = form.querySelector('input[name="' + name + '"]');
      return !!(el && el.checked);
    };
    var radio = function (name) {
      var el = form.querySelector('input[name="' + name + '"]:checked');
      return el ? el.value : undefined;
    };
    return {
      style: radio("style"),
      units: radio("units"),
      align: radio("align"),
      layout: value("layout"),
      iconSide: value("iconSide"),
      free: freeLayout(),
      animations: checked("animations"),
      transitions: checked("transitions"),
      transparent: checked("transparent"),
      show: show(checked),
    };
  }

  form.addEventListener("change", function (event) {
    if (!event.target || event.target.name === "cityQuery") return;
    // Leaving the free layout ends the editing of it.
    if (event.target.name === "layout" && event.target.value !== "free" && stopEditing) stopEditing();
    post({ type: "weather-settings", settings: formSettings() });
  });
  var stopEditing = null;
  if (frame) {
    frame.addEventListener("load", function () {
      post({ type: "weather-settings", settings: formSettings() });
      // The overlay is not told a hidden city's name by the server (lib/weatherWidget.js's
      // publicCityName); the owner's preview is, so ticking "City" shows it before saving.
      if (form.dataset.cityName) post({ type: "weather-city", city: form.dataset.cityName });
      // A reloaded preview starts outside the editor.
      if (editing) post({ type: "weather-edit", on: true });
    });
  }

  // --- the preview's shape: the OBS source's ------------------------------------------------------

  var stage = document.getElementById("weather-preview-stage");
  function shapeStage() {
    var w = parseInt(value("sourceW"), 10);
    var h = parseInt(value("sourceH"), 10);
    if (stage && w > 0 && h > 0) stage.style.aspectRatio = w + " / " + h;
  }
  ["sourceW", "sourceH"].forEach(function (name) {
    var el = form.querySelector('[name="' + name + '"]');
    if (el) el.addEventListener("input", shapeStage);
  });

  // --- the mouse editor (it runs inside the preview, public/js/weather-widget.js) -------------

  var bar = document.getElementById("weather-editor-bar");
  var editing = false;
  if (bar) {
    bar.hidden = false;
    var toggle = bar.querySelector("[data-edit-toggle]");
    var editHint = bar.querySelector("[data-edit-hint]");
    var setEditing = function (on) {
      editing = on;
      toggle.textContent = on ? toggle.dataset.labelOn : toggle.dataset.labelOff;
      toggle.classList.toggle("border-purple-500", on);
      editHint.hidden = !on;
      if (on && value("layout") !== "free") {
        form.querySelector('[name="layout"]').value = "free";
        post({ type: "weather-settings", settings: formSettings() });
      }
      post({ type: "weather-edit", on: on });
    };
    toggle.addEventListener("click", function () {
      setEditing(!editing);
    });
    stopEditing = function () {
      if (editing) setEditing(false);
    };
    bar.querySelector("[data-edit-reset]").addEventListener("click", function () {
      post({ type: "weather-free-reset" });
    });
  }

  // The preview reports how much of the source the widget fills. Where a band of the source stays
  // empty, the size that would hug the widget is offered: entered here it reshapes the preview,
  // entered in the source's properties in OBS it makes the source's frame the widget's.
  var tightBox = form.querySelector("[data-tight]");
  var tightSize = null;
  window.addEventListener("message", function (event) {
    if (!tightBox || event.origin !== window.location.origin || !event.data || event.data.type !== "weather-tight") return;
    var sw = parseInt(value("sourceW"), 10);
    var sh = parseInt(value("sourceH"), 10);
    if (event.data.w === null || !(sw > 0 && sh > 0)) {
      tightBox.hidden = true;
      return;
    }
    var w = Math.min(sw, Math.round(sw * event.data.w));
    var h = Math.min(sh, Math.round(sh * event.data.h));
    // A sliver is not worth a change in OBS.
    if (sw - w < sw * 0.04 && sh - h < sh * 0.04) {
      tightBox.hidden = true;
      return;
    }
    tightSize = { w: w, h: h };
    tightBox.querySelector("[data-tight-text]").textContent = tightBox.dataset.text.replace("{{size}}", w + " × " + h);
    tightBox.hidden = false;
  });
  if (tightBox) {
    tightBox.querySelector("[data-tight-apply]").addEventListener("click", function () {
      if (!tightSize) return;
      form.querySelector('[name="sourceW"]').value = tightSize.w;
      form.querySelector('[name="sourceH"]').value = tightSize.h;
      shapeStage();
      tightBox.hidden = true;
    });
  }

  // The preview sends every change of the free layout; it is saved with the form.
  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin || !event.data || event.data.type !== "weather-free") return;
    var field = form.querySelector('[name="free"]');
    if (field) field.value = JSON.stringify(event.data.free || {});
  });

  // --- preview buttons -------------------------------------------------------------------------

  var buttons = document.getElementById("weather-preview-buttons");
  if (buttons) {
    buttons.hidden = false;
    var mark = function (active) {
      buttons.querySelectorAll("button").forEach(function (b) {
        b.classList.toggle("border-purple-500", b === active);
        b.classList.toggle("text-neutral-100", b === active);
      });
    };
    buttons.addEventListener("click", function (event) {
      var b = event.target.closest("button");
      if (!b) return;
      mark(b);
      if (b.hasAttribute("data-preview-live")) {
        post({ type: "weather-live" });
        return;
      }
      post({
        type: "weather-preview",
        code: Number(b.dataset.previewCode),
        isDay: b.dataset.previewDay === "1",
        temp: Number(b.dataset.previewTemp),
      });
    });
  }

  // --- city search -----------------------------------------------------------------------------

  var input = document.getElementById("weather-city");
  var list = document.getElementById("weather-city-results");
  var hint = form.querySelector("[data-city-hint]");
  var hintText = hint ? hint.textContent : "";
  var hidden = {
    name: form.querySelector('input[name="cityName"]'),
    admin1: form.querySelector('input[name="cityAdmin1"]'),
    country: form.querySelector('input[name="cityCountry"]'),
    lat: form.querySelector('input[name="cityLat"]'),
    lon: form.querySelector('input[name="cityLon"]'),
  };
  var searchUrl = form.getAttribute("action") + "/cities";
  var timer = null;
  var seq = 0;
  var results = [];
  var active = -1;

  function clearPicked() {
    Object.keys(hidden).forEach(function (k) {
      if (hidden[k]) hidden[k].value = "";
    });
  }

  function setHint(text) {
    if (hint) hint.textContent = text;
  }

  function close() {
    list.hidden = true;
    list.textContent = "";
    active = -1;
  }

  function pick(city) {
    input.value = city.label;
    hidden.name.value = city.name;
    hidden.admin1.value = city.admin1 || "";
    hidden.country.value = city.country || "";
    hidden.lat.value = city.lat;
    hidden.lon.value = city.lon;
    close();
    setHint(hintText);
    post({ type: "weather-city", city: city.name });
  }

  function highlight(index) {
    active = index;
    Array.prototype.forEach.call(list.children, function (li, i) {
      li.classList.toggle("bg-neutral-800", i === index);
    });
  }

  function render() {
    list.textContent = "";
    results.forEach(function (city, i) {
      var li = document.createElement("li");
      li.className = "px-3 py-2 text-sm text-neutral-200 cursor-pointer hover:bg-neutral-800";
      li.textContent = city.label;
      li.addEventListener("mousedown", function (event) {
        event.preventDefault();
        pick(results[i]);
      });
      list.appendChild(li);
    });
    list.hidden = results.length === 0;
    active = -1;
  }

  function search() {
    var query = input.value.trim();
    if (query.length < 2) {
      close();
      return;
    }
    var mine = ++seq;
    setHint(hint ? hint.dataset.searching : "");
    fetch(searchUrl + "?q=" + encodeURIComponent(query), { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (res) {
        if (mine !== seq) return;
        results = (res.data && res.data.results) || [];
        render();
        setHint(!res.ok ? hint.dataset.failed : results.length ? hintText : hint.dataset.nothing);
      })
      .catch(function () {
        if (mine === seq) setHint(hint ? hint.dataset.failed : "");
      });
  }

  input.addEventListener("input", function () {
    clearPicked();
    clearTimeout(timer);
    timer = setTimeout(search, 350);
  });
  input.addEventListener("keydown", function (event) {
    if (list.hidden) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlight(Math.min(results.length - 1, active + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlight(Math.max(0, active - 1));
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      pick(results[active]);
    } else if (event.key === "Escape") {
      close();
    }
  });
  input.addEventListener("blur", function () {
    setTimeout(close, 150);
  });
})();
