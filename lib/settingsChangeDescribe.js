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
  if (parts.length === 0) return t("settingsChangeLog.describe.commandUpdated", { name: target });
  return `${t("settingsChangeLog.describe.commandLabel", { name: target })}: ${parts.join("; ")}`;
}

function describeCounter(t, action, target, before, after) {
  if (action === "delete") return t("settingsChangeLog.describe.counterDeleted", { name: target });
  if (!before) {
    return t("settingsChangeLog.describe.counterAdded", {
      name: target,
      count: after.count,
      access: t(`settingsChangeLog.describe.access.${after.access}`),
    });
  }

  const parts = [];
  if (before.count !== after.count) {
    parts.push(t("settingsChangeLog.describe.counterCountChanged", { before: before.count, after: after.count }));
  }
  if (before.access !== after.access) {
    parts.push(
      t("settingsChangeLog.describe.counterAccessChanged", {
        before: t(`settingsChangeLog.describe.access.${before.access}`),
        after: t(`settingsChangeLog.describe.access.${after.access}`),
      })
    );
  }
  if (parts.length === 0) return t("settingsChangeLog.describe.counterUpdated", { name: target });
  return `${t("settingsChangeLog.describe.counterLabel", { name: target })}: ${parts.join("; ")}`;
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
  if (category === "counter") return describeCounter(t, action, target, before, after);
  return describeSettingsChange(t, action, target, before, after, context);
}

module.exports = { describeChange };
