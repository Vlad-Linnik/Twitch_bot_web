// Turns one SettingsChangeLog entry's raw before/after (see db/settingsChangeLogRepo.js) into a
// short, human-readable sentence - the raw values are full config sub-objects or bare field paths
// like "commands.settimer" that mean nothing to a channel owner who isn't reading this repo's
// source. The raw before/after is still available to whoever renders the entry (views tuck it
// behind a collapsed <details>), this module just supplies the one-line summary that's the
// default, primary thing a viewer sees.
const MAX_QUOTE_LEN = 60;

function truncate(text, max) {
  const str = String(text ?? "");
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function q(value) {
  return `"${truncate(value, MAX_QUOTE_LEN)}"`;
}

function diffArray(before, after) {
  const b = Array.isArray(before) ? before : [];
  const a = Array.isArray(after) ? after : [];
  return {
    added: a.filter((x) => !b.includes(x)),
    removed: b.filter((x) => !a.includes(x)),
  };
}

const toSeconds = (ms) => Math.round((ms || 0) / 1000);

function describeCommandFieldChanges(t, before, after) {
  const b = before || {};
  const a = after || {};
  const parts = [];

  if (a.enabled !== undefined && b.enabled !== a.enabled) {
    parts.push(t(a.enabled ? "settingsChangeLog.describe.commandEnabled" : "settingsChangeLog.describe.commandDisabled"));
  }
  if (a.cooldownMs !== undefined && b.cooldownMs !== a.cooldownMs) {
    parts.push(t("settingsChangeLog.describe.cooldownChanged", { before: toSeconds(b.cooldownMs), after: toSeconds(a.cooldownMs) }));
  }
  if (a.minMessagesBetween !== undefined && b.minMessagesBetween !== a.minMessagesBetween) {
    parts.push(t("settingsChangeLog.describe.minMessagesChanged", { before: b.minMessagesBetween ?? 0, after: a.minMessagesBetween }));
  }
  for (const field of ["signature", "remSignature", "acceptSignature"]) {
    if (a[field] !== undefined && b[field] !== a[field]) {
      parts.push(t("settingsChangeLog.describe.signatureChanged", { before: b[field] ?? "—", after: a[field] }));
    }
  }
  return parts;
}

function describeResponsesChanges(t, before, after) {
  const b = before || {};
  const a = after || {};
  const parts = [];
  if (JSON.stringify(b.busy) !== JSON.stringify(a.busy)) {
    parts.push(t("settingsChangeLog.describe.responsesBusyChanged", { count: (a.busy || []).length }));
  }
  if (JSON.stringify(b.yesNo) !== JSON.stringify(a.yesNo)) {
    parts.push(t("settingsChangeLog.describe.responsesYesNoChanged", { count: (a.yesNo || []).length }));
  }
  return parts;
}

function describeCustomCommand(t, action, target, before, after) {
  if (action === "delete") return t("settingsChangeLog.describe.commandDeleted", { name: target });
  if (!before) {
    return t("settingsChangeLog.describe.commandAdded", { name: target });
  }

  const parts = [];
  if (after && before.result !== after.result) {
    parts.push(t("settingsChangeLog.describe.commandResultChanged", { after: q(after.result) }));
  }
  if (after && before.timer !== after.timer) {
    parts.push(
      after.timer
        ? t("settingsChangeLog.describe.commandTimerSet", { seconds: toSeconds(after.timer) })
        : t("settingsChangeLog.describe.commandTimerCleared")
    );
  }
  if (after && !!before.pin !== !!after.pin) {
    parts.push(t(after.pin ? "settingsChangeLog.describe.commandPinned" : "settingsChangeLog.describe.commandUnpinned"));
  }
  if (after && !!before.announce !== !!after.announce) {
    parts.push(t(after.announce ? "settingsChangeLog.describe.commandAnnounceOn" : "settingsChangeLog.describe.commandAnnounceOff"));
  }
  // enabled/modOnly compared with !!, not ===: legacy rows saved before this field existed carry
  // undefined rather than false, and !!undefined === !!false - so an old row's first save under
  // the current schema doesn't read as a spurious flip.
  if (after && !!before.enabled !== !!after.enabled) {
    parts.push(t(after.enabled ? "settingsChangeLog.describe.commandEnabled" : "settingsChangeLog.describe.commandDisabled"));
  }
  if (after && !!before.modOnly !== !!after.modOnly) {
    parts.push(t(after.modOnly ? "settingsChangeLog.describe.commandModOnlyOn" : "settingsChangeLog.describe.commandModOnlyOff"));
  }
  if (after && (before.group || "") !== (after.group || "")) {
    parts.push(
      after.group
        ? t("settingsChangeLog.describe.commandGroupSet", { group: after.group })
        : t("settingsChangeLog.describe.commandGroupCleared")
    );
  }
  if (parts.length === 0) return t("settingsChangeLog.describe.commandUpdated", { name: target });
  return `${t("settingsChangeLog.describe.commandLabel", { name: target })}: ${parts.join("; ")}`;
}

// Rows of two shapes reach this: category "variable" stores {name, value, access}, and category
// "counter" - written before counters were renamed to variables - stores {counter_name, count,
// access}. The history in the web db is never rewritten, so both are read here.
const variableValue = (doc) => (doc.value !== undefined ? doc.value : doc.count);

function describeVariable(t, action, target, before, after) {
  if (action === "delete") return t("settingsChangeLog.describe.variableDeleted", { name: target });
  if (!before) {
    return t("settingsChangeLog.describe.variableAdded", {
      name: target,
      value: variableValue(after),
      access: t(`settingsChangeLog.describe.access.${after.access}`),
    });
  }

  const parts = [];
  if (variableValue(before) !== variableValue(after)) {
    parts.push(
      t("settingsChangeLog.describe.variableValueChanged", { before: variableValue(before), after: variableValue(after) })
    );
  }
  if (before.access !== after.access) {
    parts.push(
      t("settingsChangeLog.describe.variableAccessChanged", {
        before: t(`settingsChangeLog.describe.access.${before.access}`),
        after: t(`settingsChangeLog.describe.access.${after.access}`),
      })
    );
  }
  if (parts.length === 0) return t("settingsChangeLog.describe.variableUpdated", { name: target });
  return `${t("settingsChangeLog.describe.variableLabel", { name: target })}: ${parts.join("; ")}`;
}

// bannedWords.words / spamSignatures are logged as full before/after arrays (see
// registerWordListRoutes in routes/settings.js), not a single word - reconstruct which word was
// actually touched from the array diff instead of dumping both arrays.
function describeWordListChange(t, action, before, after, labelPrefix) {
  const { added, removed } = diffArray(before, after);

  if (action === "add" && added.length === 1) return t(`${labelPrefix}Added`, { word: q(added[0]) });
  if (action === "delete" && removed.length === 1) return t(`${labelPrefix}Removed`, { word: q(removed[0]) });
  if (action === "update" && added.length === 1 && removed.length === 1) {
    return t(`${labelPrefix}Renamed`, { before: q(removed[0]), after: q(added[0]) });
  }

  const bits = [];
  if (added.length) bits.push(t(`${labelPrefix}AddedMany`, { list: added.map(q).join(", ") }));
  if (removed.length) bits.push(t(`${labelPrefix}RemovedMany`, { list: removed.map(q).join(", ") }));
  return bits.join("; ") || t("settingsChangeLog.describe.noVisibleChange");
}

// routes/unbanBureau.js logs one row per stamped appeal (and one per chat vote started). `target`
// is the appealing user's login; before/after carry the decision itself, which the wording below
// already states, so neither is read here.
//
// A weapon row is the exception: it has no target at all (the page never picks one - the bot draws
// it seconds later, and it is not written back here because this journal lives in the web DB the
// bot cannot reach), and one row can stand for a whole burst of them - see BURST_ACTIONS in
// db/settingsChangeLogRepo.js.
function describeUnbanRequest(t, action, target, count) {
  if (action === "approve") return t("settingsChangeLog.describe.unbanApproved", { target });
  if (action === "deny") return t("settingsChangeLog.describe.unbanDenied", { target });
  if (action === "vote") return t("settingsChangeLog.describe.unbanVote", { target });
  if (action === "sniper") return withCount(t("settingsChangeLog.describe.unbanSniper"), count);
  if (action === "grenade") return withCount(t("settingsChangeLog.describe.unbanGrenade"), count);
  return t("settingsChangeLog.describe.genericChanged");
}

// The tally is appended rather than built into the phrase: "×5" is the same in every locale, and a
// single shot then reads exactly as it did before counting existed. A missing or 1 count is one
// event - see db/settingsChangeLogRepo.js.
function withCount(text, count) {
  return count > 1 ? `${text} ×${count}` : text;
}

// Discussion moderation by the channel owner or a moderator (routes/news.js's logModeration).
// target is the commenter's login - the comment itself may be long and is not copied into the log.
function describeComment(t, action, target) {
  if (action === "delete") return t("settingsChangeLog.describe.commentDeleted", { target });
  if (action === "restrict") return t("settingsChangeLog.describe.commenterRestricted", { target });
  if (action === "unrestrict") return t("settingsChangeLog.describe.commenterUnrestricted", { target });
  return t("settingsChangeLog.describe.genericChanged");
}

// A movie/game card written by the owner or a moderator (routes/movies.js's logWrite); target is
// the card's title at the time.
function describeMedia(t, action, target) {
  if (action === "create") return t("settingsChangeLog.describe.mediaCreated", { target });
  if (action === "update") return t("settingsChangeLog.describe.mediaUpdated", { target });
  if (action === "delete") return t("settingsChangeLog.describe.mediaDeleted", { target });
  return t("settingsChangeLog.describe.genericChanged");
}

function describeSettingsChange(t, action, target, before, after, context) {
  if (target === "bannedWords.words") {
    return describeWordListChange(t, action, before, after, "settingsChangeLog.describe.bannedWord");
  }
  if (target === "spamSignatures") {
    return describeWordListChange(t, action, before, after, "settingsChangeLog.describe.spamSignature");
  }
  if (target === "bannedWords.timeoutReason") {
    return t("settingsChangeLog.describe.timeoutReasonChanged", { before: q(before), after: q(after) });
  }
  if (target === "spamBanReason") {
    return t("settingsChangeLog.describe.spamBanReasonChanged", { before: q(before), after: q(after) });
  }
  if (target === "commands.insult.enabled") {
    return t(after ? "settingsChangeLog.describe.insultDetectionOn" : "settingsChangeLog.describe.insultDetectionOff");
  }
  if (target.startsWith("moderator-permission:")) {
    const id = target.slice("moderator-permission:".length);
    const name = context?.moderatorNames?.get(String(id)) || id;
    return t(after ? "settingsChangeLog.describe.modPermissionGranted" : "settingsChangeLog.describe.modPermissionRevoked", { name });
  }
  if (target === "responses") {
    const parts = describeResponsesChanges(t, before, after);
    return parts.length ? parts.join("; ") : t("settingsChangeLog.describe.noVisibleChange");
  }
  if (target.startsWith("commands.")) {
    const name = target.slice("commands.".length);
    const parts = describeCommandFieldChanges(t, before, after);
    if (parts.length === 0) return t("settingsChangeLog.describe.commandUpdated", { name });
    return `${t("settingsChangeLog.describe.commandLabel", { name })}: ${parts.join("; ")}`;
  }
  // Fallback for any target this module doesn't know yet - still no raw JSON, just an honest
  // "something changed" instead of silently showing nothing.
  return t("settingsChangeLog.describe.genericChanged");
}

// context.moderatorNames: optional Map<string userId, string displayName> for
// "moderator-permission:<id>" targets - see routes/settings.js and routes/admin.js, which batch
// resolve these via profileCacheRepo before rendering a page of entries.
function describeChange(t, entry, context) {
  const { category, action, target, before, after } = entry;
  if (category === "custom_command") return describeCustomCommand(t, action, target, before, after);
  if (category === "variable" || category === "counter") return describeVariable(t, action, target, before, after);
  if (category === "unban_request") return describeUnbanRequest(t, action, target, entry.count);
  if (category === "comment") return describeComment(t, action, target);
  if (category === "media") return describeMedia(t, action, target);
  return describeSettingsChange(t, action, target, before, after, context);
}

module.exports = { describeChange };
