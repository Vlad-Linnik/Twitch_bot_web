// Sorting and search for the custom-commands list (/<channel>/settings/custom-commands/commands).
// Pure: plain objects in, plain objects out, no DOM - public/js/custom-commands.js reads the rows
// into items, asks this file for an order and a verdict per row, and moves the <li>s itself.
//
// It lives in public/js rather than lib/ because the browser is what runs it and lib/ is not
// served; the `module.exports` guard at the bottom lets tests/commandListOrder.test.js require()
// this exact file, the same arrangement as public/js/emoteMatch.js. Wrapped in an IIFE because
// every page script shares one global scope - a bare top-level const here could collide with
// another script's and silently kill whichever loads second.
(function (root) {
  "use strict";

  // The order the <select> lists them in. "name" is the default because it is the order the
  // server renders (customCommandsRepo.list sorts by command), so a visitor who never touches the
  // control sees the list exactly as it was before sorting existed.
  const SORT_MODES = ["enabled", "newest", "uses", "name"];
  const DEFAULT_SORT = "name";

  function parseSortMode(raw) {
    return SORT_MODES.includes(raw) ? raw : DEFAULT_SORT;
  }

  function byName(a, b) {
    return String(a.command).localeCompare(String(b.command));
  }

  // items: [{command, enabled, createdAt, uses}] - uses is the bot's call counter; createdAt in ms (the Mongo ObjectId's timestamp, i.e.
  // when the command was first created, by either chat or the panel), 0 when unknown.
  // Every mode falls back to the name so equal keys never shuffle between two renders.
  function compareFor(mode) {
    switch (parseSortMode(mode)) {
      case "enabled":
        return (a, b) => (Number(!!b.enabled) - Number(!!a.enabled)) || byName(a, b);
      case "newest":
        return (a, b) => ((Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)) || byName(a, b);
      case "uses":
        return (a, b) => ((Number(b.uses) || 0) - (Number(a.uses) || 0)) || byName(a, b);
      default:
        return byName;
    }
  }

  function sortCommands(items, mode) {
    return (Array.isArray(items) ? items : []).slice().sort(compareFor(mode));
  }

  // Case-insensitive, whitespace-tolerant, and "ё" = "е": Russian chat text is typed both ways and
  // a mod searching "ещё" must find "еще". Nothing fuzzier than that - a search box that matches
  // things the mod cannot see the reason for is worse than one that misses.
  function normalizeText(text) {
    return String(text ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  }

  // Everything a mod might remember a command by: its name and aliases (also with the "!" they are
  // typed with in chat), its text, and each per-category override's category and text.
  function buildHaystack({ command, aliases, result, categoryTexts } = {}) {
    const parts = [];
    for (const trigger of [command, ...(Array.isArray(aliases) ? aliases : [])]) {
      if (trigger) parts.push(trigger, `!${trigger}`);
    }
    parts.push(result);
    for (const ov of Array.isArray(categoryTexts) ? categoryTexts : []) {
      if (ov) parts.push(ov.category, ov.result);
    }
    return parts.filter((p) => p !== undefined && p !== null && p !== "").map(normalizeText).join("\n");
  }

  // Every word of the query has to occur somewhere in the haystack, in any order: "pin стрим" finds
  // a command whose name contains "pin" and whose text mentions the stream.
  function matchesQuery(haystack, query) {
    const words = normalizeText(query).split(" ").filter(Boolean);
    if (!words.length) return true;
    const hay = String(haystack ?? "");
    return words.every((w) => hay.includes(w));
  }

  const api = { SORT_MODES, DEFAULT_SORT, parseSortMode, sortCommands, normalizeText, buildHaystack, matchesQuery };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.CommandListOrder = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
