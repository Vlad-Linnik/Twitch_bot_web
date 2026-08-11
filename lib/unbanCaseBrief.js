// Turns an unban case + its dossier into the plain-text brief handed to the two "expert" agents
// (Адвокат / Прокурор) whose opinions end up on the desk's fourth sheet.
//
// Lives in lib/ rather than inline in routes/adminApi.js for the reason lib/settingsValidation.js
// gives in its own header: this is the kind of pure, testable logic a route should require() rather
// than define. It touches no database - the caller passes what db/unbanDossierRepo.js already built.
//
// The brief is deliberately a SUBSET of what the review page shows a human, phrased the same way.
// An agent that reasons from a fact the moderator can't see next to it produces an argument the
// moderator cannot check, which is worse than no argument at all.
//
// Two things here are load-bearing rather than cosmetic, and both are traps the UI already documents:
//
//   COVERAGE, NOT SOURCE. `counts.source` is 'twitch' or 'bot', but that is not a difference of
//   origin - the bot gets everything from Twitch too. It is a difference of COVERAGE: 'twitch' is
//   the channel's real lifetime total, 'bot' is only what the bot witnessed since it joined. The
//   live case in ../CLAUDE.md had 17 bans / 49 timeouts at Twitch and 0 / 0 in ModeratorActionLogs.
//   Handing an agent a bare "0" from the second kind invites "чистая история" about a serial
//   offender, so the count is always stamped with how far back it can see.
//
//   THREE-STATE FIELDS STAY THREE-STATE. Subscription is never rendered as a boolean: "unavailable"
//   means we were not allowed to look, which is not "no". Flattening it marks an applicant down for
//   something that was never established. (Ban-sharing used to get the same treatment here, but it's
//   no longer sent at all - see riskLines()'s comment.)
const MAX_MESSAGE_CHARS = 200;
const DEFAULT_RECENT_MESSAGES = 30;

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmtDate(value) {
  const date = toDate(value);
  if (!date) return "неизвестно";
  return `${pad(date.getUTCDate())} ${MONTHS_GENITIVE[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function fmtDateTime(value) {
  const date = toDate(value);
  if (!date) return "неизвестно";
  return `${fmtDate(date)}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function fmtClock(value) {
  const date = toDate(value);
  if (!date) return "--:--";
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

// Russian needs three plural forms, and getting them wrong in a document an agent is asked to
// quote from makes the whole brief read as machine output.
function plural(n, one, few, many) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function humanSpan(fromValue, toValue) {
  const from = toDate(fromValue);
  const to = toDate(toValue);
  if (!from || !to) return null;
  const months = Math.max(0, Math.round((to - from) / (30.44 * 24 * 3600 * 1000)));
  if (months < 1) {
    const days = Math.max(0, Math.round((to - from) / (24 * 3600 * 1000)));
    return `${days} ${plural(days, "день", "дня", "дней")}`;
  }
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (!years) return `${months} ${plural(months, "месяц", "месяца", "месяцев")}`;
  const yearPart = `${years} ${plural(years, "год", "года", "лет")}`;
  if (!rest) return yearPart;
  return `${yearPart} ${rest} ${plural(rest, "месяц", "месяца", "месяцев")}`;
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} ${plural(sec, "секунду", "секунды", "секунд")}`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} ${plural(min, "минуту", "минуты", "минут")}`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ${plural(hours, "час", "часа", "часов")}`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, "день", "дня", "дней")}`;
}

// Chat lines are attacker-controlled text that will be pasted into a prompt. Collapsing whitespace
// keeps a message from forging brief structure with its own newlines and indentation.
function oneLine(text, limit = MAX_MESSAGE_CHARS) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

const ACTION_LABEL = {
  ban: "бан",
  timeout: "мут",
  warn: "предупреждение",
  delete: "удаление сообщения",
  unban: "снятие бана",
  untimeout: "снятие мута",
  warnAck: "подтверждение предупреждения",
  unbanRequest: "подана апелляция",
  unbanApproved: "апелляция одобрена",
  unbanDenied: "апелляция отклонена",
};

function subscriptionLine(subscription) {
  if (!subscription || !subscription.state) return "неизвестно (данных нет)";
  if (subscription.state === "unavailable") {
    return "неизвестно (канал не продаёт подписки — это НЕ значит «не подписан»)";
  }
  if (subscription.state === "none") return "нет";
  if (subscription.prime) return "есть (Prime)";
  return subscription.tier ? `есть (${subscription.tier})` : "есть";
}

const LIKELIHOOD = {
  UNLIKELY: "маловероятно",
  POSSIBLE: "возможно",
  LIKELY: "вероятно",
};

const TREATMENT = {
  ACTIVE_MONITORING: "под наблюдением",
  RESTRICTED: "ограничен",
};

// Deliberately omits `sharedBanChannels`/`banSharing`: in practice the shared-ban list is empty
// for essentially every applicant, so the only line it ever produced was the same "нет (проверено)"
// boilerplate - not a real signal, but shaped exactly like one, which invited agents to cite it as
// if absence of shared bans said something about the applicant's conduct elsewhere. See
// feedback_amnesty_agent_prompt_issues memory: better to not hand it over than to keep re-explaining
// in the prompt why it can't be leaned on.
function riskLines(risk) {
  const lines = [];
  if (risk) {
    if (risk.banEvasion && risk.banEvasion !== "UNLIKELY") {
      lines.push(`Обход бана: ${LIKELIHOOD[risk.banEvasion] || risk.banEvasion}`);
    }
    if (risk.harassment && risk.harassment !== "UNLIKELY") {
      lines.push(`Склонность к травле: ${LIKELIHOOD[risk.harassment] || risk.harassment}`);
    }
    if (risk.treatment && risk.treatment !== "NONE") {
      lines.push(`Ограничения Twitch: ${TREATMENT[risk.treatment] || risk.treatment}`);
    }
  }
  if (!lines.length) lines.push("Twitch ничего особенного не отметил");
  return lines;
}

function countsBlock(counts) {
  const c = counts || {};
  // 'twitch' = the channel's real lifetime totals; 'bot' = only what the bot has witnessed. See
  // the header: this is a coverage caveat, not a provenance one.
  const coverage =
    c.source === "twitch"
      ? "за всё время существования канала"
      : "ТОЛЬКО с момента, как бот зашёл на канал — более раннее ему не видно, счётчики могут быть сильно занижены";

  const lines = [`Охват этих цифр: ${coverage}.`];
  const row = (label, total, liftedLabel, lifted) => {
    if (!total) return `${label}: 0`;
    const suffix = lifted ? ` (из них ${liftedLabel}: ${lifted})` : "";
    return `${label}: ${total}${suffix}`;
  };
  lines.push(row("Баны", c.ban || 0, "сняты", c.unban || 0));
  lines.push(row("Муты", c.timeout || 0, "сняты", c.untimeout || 0));
  lines.push(row("Предупреждения", c.warn || 0, "подтверждены", c.warnAck || 0));

  // Only RESOLVED past appeals count as history: the number of appeals FILED includes the one
  // being reviewed right now, so quoting it would read as "уже подавал раньше" for a first-timer.
  const approved = c.unbanApproved || 0;
  const denied = c.unbanDenied || 0;
  lines.push(
    approved || denied
      ? `Прошлые апелляции: одобрено ${approved}, отклонено ${denied}`
      : "Прошлые апелляции: рассмотренных нет (текущая — первая)"
  );
  if (c.truncated) lines.push("(Twitch отдал не всю историю — цифры могут быть неполными)");
  return lines;
}

function logLine(entry) {
  if (entry.type === "action") {
    const label = ACTION_LABEL[entry.action] || entry.action;
    const who = entry.selfActed ? "сам заявитель" : entry.modDisplayName || "модератор";
    const duration = fmtDuration(entry.durationMs);
    const reason = entry.reason ? `, причина: «${oneLine(entry.reason, 120)}»` : "";
    return `  ${fmtClock(entry.timestamp)}  >>> ${label.toUpperCase()}${duration ? ` на ${duration}` : ""} (${who})${reason}`;
  }
  const text = oneLine(entry.text) || "(пустое сообщение)";
  // The bot's guess at which line an action was probably for. Never present on a mirrored Twitch
  // line, so its absence proves nothing - hence the wording.
  const flag = entry.probableCause ? "  <-- вероятно, за это и наказали" : "";
  return `  ${fmtClock(entry.timestamp)}  ${text}${flag}`;
}

// Two punishments seconds apart are indistinguishable once the header is rounded to the minute and
// both windows pull the same preceding messages - the block renders twice, byte for byte, and reads
// as a copy-paste artifact rather than as two real actions. That is not hypothetical: on the
// king_of_toucanss case two genuine mutes 40 seconds apart (distinct Twitch action ids) produced
// identical blocks, and a live run had the advocate declare the record padded with a duplicate and
// the prosecutor concede the point - a real punishment argued away on the strength of a formatting
// collision. Hence seconds here, and only here: fmtDateTime's minute precision is right for the
// standing punishment and the appeal date, which have nothing to collide with.
function fmtDateTimeSec(value) {
  const date = toDate(value);
  if (!date) return "неизвестно";
  return `${fmtDateTime(date)}:${pad(date.getUTCSeconds())}`;
}

// Same window = same message list by timestamp and text. Compared by content rather than by id
// because the mirrored Twitch lines and our own carry different id spaces (see the repo's join
// rule), and a window can legitimately be built from either.
function sameWindow(a, b) {
  const left = (a && a.messages) || [];
  const right = (b && b.messages) || [];
  if (!left.length || left.length !== right.length) return false;
  return left.every((msg, i) => {
    const l = toDate(msg.timestamp);
    const r = toDate(right[i].timestamp);
    return l && r && l.getTime() === r.getTime() && String(msg.text) === String(right[i].text);
  });
}

// `contexts` comes from db/unbanDossierRepo.js's getPunishmentContexts(): the handful of messages
// immediately preceding each past punishment. This is what lets either side check an appeal's own
// account of events ("бан был из-за мема") instead of taking it on faith.
function contextBlock(contexts) {
  const lines = [];
  let prev = null;
  for (const ctx of contexts) {
    const label = ACTION_LABEL[ctx.action] || ctx.action;
    const duration = fmtDuration(ctx.durationMs);
    const who = ctx.modDisplayName ? `, ${ctx.modDisplayName}` : "";
    lines.push(`  --- ${label}${duration ? ` на ${duration}` : ""} ${fmtDateTimeSec(ctx.timestamp)}${who} ---`);
    if (!ctx.messages || !ctx.messages.length) {
      lines.push("    (сообщений перед этим наказанием не сохранилось)");
    } else if (sameWindow(ctx, prev)) {
      // Reprinting the identical window is what made the two actions look like one. Saying the gap
      // out loud instead states the fact both sides actually need: nothing was written between
      // them, so the second punishment answers the same messages as the first.
      const gap = fmtDuration(toDate(ctx.timestamp) - toDate(prev.timestamp));
      lines.push(
        `    (вынесено через ${gap} после предыдущего наказания, за те же сообщения — ` +
          "в промежутке заявитель ничего не писал; это два разных наказания, а не повтор записи)"
      );
    } else {
      for (const msg of ctx.messages) {
        lines.push(`    ${fmtClock(msg.timestamp)}  ${oneLine(msg.text) || "(пустое сообщение)"}`);
      }
    }
    lines.push("");
    prev = ctx;
  }
  return lines;
}

/**
 * @param {object} params
 * @param {object} params.request  the raw UnbanRequests document
 * @param {object} params.dossier  db/unbanDossierRepo.js's getDossier() result
 * @param {Array}  [params.contexts]  getPunishmentContexts() result
 * @param {string} [params.channelLogin]
 * @param {string[]} [params.channelRules]  overrides dossier.channelRules (tests / offline runs)
 * @param {number} [params.recentMessages]
 * @param {Date}   [params.now]  injectable for tests
 * @returns {string} plain-text brief
 */
function buildCaseBrief({
  request,
  dossier,
  contexts = [],
  channelLogin = null,
  channelRules = null,
  recentMessages = DEFAULT_RECENT_MESSAGES,
  now = new Date(),
} = {}) {
  const req = request || {};
  const d = dossier || {};
  const channel = channelLogin || req.channelLogin || "неизвестный канал";
  const applicant = req.userDisplayName || req.userLogin || "неизвестный";

  const out = [];
  out.push(`ДЕЛО: ${applicant} — канал ${channel}`);
  out.push("");

  // First, because it is the yardstick everything below is measured against. Without it an
  // accusation can only appeal to tone, and a defence can only appeal to the absent ban reason -
  // which is exactly the pair of empty arguments this section exists to prevent. Sourced from
  // Twitch's own `chatSettings.rules` via the bot's mirror, not from anything typed on this site,
  // so it is the same list viewers see under the stream. Absent for a channel that posted none.
  const rules = (channelRules || d.channelRules || []).map((line) => String(line ?? "").trim()).filter(Boolean);
  if (rules.length) {
    out.push(`ПРАВИЛА ЧАТА ${channel} (установлены владельцем канала; нарушение любого из них — законный повод для наказания)`);
    for (const line of rules) out.push(`  ${line}`);
    out.push("");
  }

  out.push("ЗАЯВИТЕЛЬ");
  // Explicitly NOT "N лет в чате": this is Twitch account registration, which says nothing about
  // when the applicant started chatting on THIS channel. That conflation showed up verbatim in
  // agent testing (see feedback_amnesty_agent_prompt_issues memory) - spelling it out here removes
  // the constant reliance on the prompt to catch it every time.
  const age = humanSpan(req.accountCreatedAt, now);
  out.push(
    `  Аккаунт в Twitch зарегистрирован: ${fmtDate(req.accountCreatedAt)}${age ? ` (${age} назад — это НЕ стаж на этом канале)` : ""}`
  );
  out.push(`  Фолловер канала: ${req.followedAt ? `да, с ${fmtDate(req.followedAt)}` : "нет"}`);
  out.push(`  Подписка: ${subscriptionLine(d.subscription)}`);

  const lastBan = d.lastBan;
  if (lastBan) {
    const label = ACTION_LABEL[lastBan.action] || lastBan.action;
    const mod = lastBan.modDisplayName || lastBan.modId || "неизвестно кем";
    // Twitch does not require a reason and most moderators don't type one, so a blank here is the
    // norm rather than a red flag. Left unqualified, it reads as "наказали непонятно за что" and
    // every defence in testing leaned on it as its main argument - which is precisely the
    // inference the channel owner says is wrong.
    const reason = lastBan.reason
      ? `«${oneLine(lastBan.reason, 200)}»`
      : "не указана (обычная практика — модераторы редко её заполняют; само по себе это НЕ значит, что наказание необоснованно)";
    out.push(`  Действующее наказание: ${label}, ${fmtDateTime(lastBan.timestamp)}, выдал ${mod}, причина: ${reason}`);
  } else {
    out.push("  Действующее наказание: в досье не зафиксировано");
  }
  const waited = humanSpan(lastBan && lastBan.timestamp, req.requestedAt);
  out.push(`  Апелляция подана: ${fmtDateTime(req.requestedAt)}${waited ? ` (спустя ${waited} после наказания)` : ""}`);
  out.push("");

  out.push("ТЕКСТ АПЕЛЛЯЦИИ (дословно, как написал заявитель)");
  const appeal = String(req.text ?? "").trim();
  out.push(appeal ? `  «${appeal.replace(/\s*\n\s*/g, " ")}»` : "  (заявитель не написал ничего)");
  out.push("");

  out.push("ИСТОРИЯ НАКАЗАНИЙ НА ЭТОМ КАНАЛЕ");
  for (const line of countsBlock(d.counts)) out.push(`  ${line}`);
  out.push("");

  out.push("ОЦЕНКА TWITCH");
  for (const line of riskLines(d.risk)) out.push(`  ${line}`);
  out.push("");

  out.push("КОММЕНТАРИИ МОДЕРАТОРОВ О ЗАЯВИТЕЛЕ");
  const comments = d.modComments || [];
  if (!comments.length) {
    out.push("  нет");
  } else {
    for (const c of comments.slice(-10)) {
      const shared = c.shared ? " [из другого канала]" : "";
      out.push(`  ${fmtDate(c.timestamp)} ${c.authorDisplayName || c.authorLogin || "?"}${shared}: «${oneLine(c.text, 300)}»`);
    }
  }
  out.push("");

  if (contexts.length) {
    out.push("ЧТО ЗАЯВИТЕЛЬ ПИСАЛ ПЕРЕД ПРОШЛЫМИ НАКАЗАНИЯМИ");
    for (const line of contextBlock(contexts)) out.push(line);
  }

  const entries = (d.log && d.log.entries) || [];
  const total = (d.log && d.log.messageCount) || 0;
  const recent = entries.slice(-recentMessages);
  out.push(
    `ПОСЛЕДНИЕ СООБЩЕНИЯ ЗАЯВИТЕЛЯ${total ? ` (показано ${recent.filter((e) => e.type === "message").length} из ${total})` : ""}`
  );
  if (!recent.length) {
    out.push("  (лог пуст)");
  } else {
    for (const entry of recent) out.push(logLine(entry));
  }

  return out.join("\n");
}

module.exports = {
  buildCaseBrief,
  MAX_MESSAGE_CHARS,
  DEFAULT_RECENT_MESSAGES,
  // exported for the unit tests
  _internal: { plural, humanSpan, oneLine, subscriptionLine, countsBlock },
};
