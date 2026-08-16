// Клиент страницы /<channel>/auto-answers.
//
// Кнопки — прогрессивное улучшение: без JS форма всё равно сохраняется обычным POST, а слова
// вписываются руками через запятую. Ни один обработчик здесь не обязателен для работы страницы.
//
// Тела запросов — urlencoded, а не JSON: приложение не монтирует глобальный express.json()
// (см. app.js). Заголовок Accept: application/json нужен, чтобы middleware/csrf.js отвечал на
// просроченный токен JSON-ом, а не HTML-страницей ошибки.
//
// Весь пользовательский текст вставляется через textContent. Сообщение из чата — это ввод
// постороннего человека на странице, куда залогинен модератор, и innerHTML здесь означал бы
// XSS ровно того класса, от которого защищается серверный рендер журнала.
//
// РАЗМЕТКА ПРОГОНА - ДВЕ КНОПКИ, И ВТОРАЯ НЕ КОСМЕТИКА. «Не то» отправляет сообщение в
// антипримеры, «подходит» - в примеры. Вывод исключающих слов никогда не берёт слово, которое
// встречается хоть в одном примере, поэтому каждое «подходит» защищает настоящие вопросы от
// того, чтобы их отрезало исключением, выведенным по соседнему мусору. Разметить сотню строк
// прогона за один заход - самый быстрый способ довести правило до ума, и обе кнопки нужны,
// чтобы обе стороны этой защиты работали.
(function () {
  "use strict";

  const form = document.getElementById("aa-form");
  const feed = document.getElementById("aa-feed");
  const examplesField = document.getElementById("aa-examples");
  const antiField = document.getElementById("aa-anti");

  async function post(url, fields) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(fields),
    });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const linesOf = (field) =>
    field ? field.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];

  /**
   * Поставить вердикт сообщению: "yes" -> в примеры, "no" -> в антипримеры, null -> снять.
   *
   * Сообщение всегда вынимается из противоположного поля: одна и та же строка не может быть
   * одновременно примером и антипримером, а checkRule() на такой паре выдал бы неразрешимый
   * конфликт («правило не ловит свой пример» и «правило ловит антипример» про одну строку).
   */
  function setVerdict(message, verdict) {
    for (const field of [examplesField, antiField]) {
      if (!field) continue;
      const keep = linesOf(field).filter((line) => line !== message);
      field.value = keep.join("\n");
    }
    if (!verdict) return;

    const target = verdict === "yes" ? examplesField : antiField;
    if (!target) return;
    const lines = linesOf(target);
    lines.push(message);
    target.value = lines.join("\n");
  }

  function verdictOf(message) {
    if (linesOf(examplesField).includes(message)) return "yes";
    if (linesOf(antiField).includes(message)) return "no";
    return null;
  }

  /** Подсветить совпавшие слова по спанам, которые вернул матчер. */
  function renderMessage(target, text, spans) {
    let cursor = 0;
    for (const span of (spans || []).slice().sort((a, b) => a.start - b.start)) {
      if (span.start < cursor) continue;
      if (span.start > cursor) target.appendChild(document.createTextNode(text.slice(cursor, span.start)));
      const mark = el(
        "mark",
        span.required
          ? "bg-amber-500/30 text-amber-100 rounded px-0.5"
          : "bg-cyan-500/20 text-cyan-100 rounded px-0.5",
        text.slice(span.start, span.end)
      );
      if (span.how) mark.title = span.how;
      target.appendChild(mark);
      cursor = span.end;
    }
    if (cursor < text.length) target.appendChild(document.createTextNode(text.slice(cursor)));
  }

  // --- разметка прогона -------------------------------------------------------------------

  const BTN_BASE = "shrink-0 px-2 py-1 rounded-md border text-xs transition-colors";
  const BTN_IDLE = { yes: "border-neutral-700 text-neutral-400 hover:border-green-700 hover:text-green-400", no: "border-neutral-700 text-neutral-400 hover:border-red-700 hover:text-red-400" };
  const BTN_ON = { yes: "border-green-700 bg-green-950/60 text-green-300", no: "border-red-800 bg-red-950/60 text-red-300" };

  function paintRow(row) {
    const message = row.dataset.message;
    const verdict = verdictOf(message);
    row.classList.toggle("bg-green-950/20", verdict === "yes");
    row.classList.toggle("bg-red-950/20", verdict === "no");
    for (const verdictName of ["yes", "no"]) {
      const button = row.querySelector(`.aa-${verdictName}`);
      if (!button) continue;
      const active = verdict === verdictName;
      button.className = `aa-${verdictName} ${BTN_BASE} ${active ? BTN_ON[verdictName] : BTN_IDLE[verdictName]}`;
    }
  }

  function updateTally(out) {
    const rows = [...out.querySelectorAll("[data-message]")];
    const counter = out.querySelector(".aa-tally");
    if (!counter) return;
    let yes = 0;
    let no = 0;
    for (const row of rows) {
      const verdict = verdictOf(row.dataset.message);
      if (verdict === "yes") yes += 1;
      else if (verdict === "no") no += 1;
    }
    counter.textContent = `размечено: ${yes} подходит · ${no} не подходит · осталось ${rows.length - yes - no}`;
  }

  // --- страница редактора -----------------------------------------------------------------

  if (form) {
    const channel = form.dataset.channel;
    const out = document.getElementById("aa-replay-out");
    const deriveBtn = document.getElementById("aa-derive");
    const note = document.getElementById("aa-derive-note");
    const replayBtn = document.getElementById("aa-replay");
    const excludeBtn = document.getElementById("aa-exclusions");
    const excludeNote = document.getElementById("aa-exclusions-note");

    deriveBtn?.addEventListener("click", async () => {
      const examples = examplesField.value;
      if (!examples.trim()) {
        note.textContent = "Сначала добавьте примеры вопроса.";
        return;
      }
      deriveBtn.disabled = true;
      note.textContent = "…";
      try {
        const data = await post(`/${channel}/auto-answers/derive.json`, { examples });
        document.getElementById("aa-required").value = data.required.map((r) => r.label).join(", ");
        document.getElementById("aa-optional").value = data.optional.map((r) => r.label).join(", ");
        // Предупреждение важнее результата: пустое пересечение выглядит как «ничего не
        // вывелось», хотя на самом деле означает «примеры не про одно и то же».
        note.textContent = data.warning
          ? "⚠ " + data.warning
          : `Обязательных: ${data.required.length}, необязательных: ${data.optional.length}`;
      } catch (err) {
        note.textContent = "Не удалось: " + err.message;
      } finally {
        deriveBtn.disabled = false;
      }
    });

    replayBtn?.addEventListener("click", async () => {
      replayBtn.disabled = true;
      out.classList.remove("hidden");
      out.replaceChildren(el("p", "text-neutral-500", "Считаю по логам канала…"));
      try {
        const fields = new URLSearchParams(new FormData(form));
        fields.set("days", "30");
        renderReplay(out, await post(`/${channel}/auto-answers/replay.json`, fields));
      } catch (err) {
        out.replaceChildren(el("p", "text-red-400", "Не удалось: " + err.message));
      } finally {
        replayBtn.disabled = false;
      }
    });

    // Обе кнопки на одном делегированном обработчике: строк в прогоне сотни, и вешать по два
    // слушателя на каждую - это сотни слушателей на ровном месте.
    out?.addEventListener("click", (event) => {
      const button = event.target.closest(".aa-yes, .aa-no");
      if (!button) return;
      const row = button.closest("[data-message]");
      const verdict = button.classList.contains("aa-yes") ? "yes" : "no";
      // Повторный клик по уже выбранной кнопке снимает пометку - иначе исправить случайный
      // клик можно было бы только руками в текстовом поле.
      const current = verdictOf(row.dataset.message);
      setVerdict(row.dataset.message, current === verdict ? null : verdict);
      paintRow(row);
      updateTally(out);
      excludeNote.textContent = "";
    });

    excludeBtn?.addEventListener("click", async () => {
      if (!linesOf(antiField).length) {
        excludeNote.textContent = "Сначала пометьте хотя бы одно лишнее срабатывание кнопкой «не то».";
        return;
      }
      excludeBtn.disabled = true;
      excludeNote.textContent = "…";
      try {
        const data = await post(`/${channel}/auto-answers/exclusions.json`, {
          examples: examplesField.value,
          antiExamples: antiField.value,
          requiredWords: document.getElementById("aa-required").value,
          optionalWords: document.getElementById("aa-optional").value,
        });
        renderExclusions(data);
      } catch (err) {
        excludeNote.textContent = "Не удалось: " + err.message;
      } finally {
        excludeBtn.disabled = false;
      }
    });

    function renderExclusions(data) {
      const field = form.querySelector('[name="excludeWords"]');
      const existing = field.value.split(",").map((s) => s.trim()).filter(Boolean);
      for (const item of data.exclusions) {
        if (!existing.includes(item.label)) existing.push(item.label);
      }
      field.value = existing.join(", ");

      // Сколько сообщений закрывает каждое слово - это то, по чему модератор решает, какие
      // оставить: закрывающее одно почти всегда подогнано под него одно и лишнее.
      excludeNote.replaceChildren();
      excludeNote.appendChild(
        el("span", "text-neutral-400", data.exclusions.map((e) => `${e.label} (${e.covers})`).join(", ") || "нечего исключать")
      );
      if (data.warning) excludeNote.appendChild(el("span", "text-amber-400", " ⚠ " + data.warning));
      for (const item of data.uncovered.slice(0, 5)) {
        excludeNote.appendChild(
          el("p", "text-[11px] text-neutral-600 mt-1", `не закрыто: «${item.text.slice(0, 80)}» — ${item.reason}`)
        );
      }
    }
  }

  function renderReplay(out, data) {
    out.replaceChildren();

    const head = el("p", "text-neutral-200 mb-1");
    head.append(
      el("strong", "text-green-400", `Сработало бы ${data.matched} раз`),
      document.createTextNode(` за ${data.days} дн. · в чат ушло бы ${data.wouldSend} (остальное съел бы кулдаун) · спрашивавших: ${data.askers}`)
    );
    out.appendChild(head);
    out.appendChild(el("p", "aa-tally text-xs text-neutral-500 mb-2", ""));

    for (const warning of data.warnings || []) {
      out.appendChild(el("p", "text-amber-400 text-xs mb-1", "⚠ " + warning));
    }

    if (!data.hits.length) {
      out.appendChild(el("p", "text-neutral-500 mt-2", "За этот период ни одного совпадения — правило слишком узкое или вопрос ещё не задавали."));
    }

    for (const hit of data.hits) {
      const row = el("div", "mt-2 pt-2 px-2 rounded border-t border-neutral-800/70 flex items-start justify-between gap-3");
      row.dataset.message = hit.message;

      const left = el("div", "min-w-0");
      const meta = el("div", "text-xs text-neutral-500");
      meta.append(
        el("span", "tabular-nums", new Date(hit.at).toLocaleString("ru-RU")),
        document.createTextNode(" · "),
        el("span", "text-neutral-400", hit.userName)
      );
      left.appendChild(meta);
      const body = el("p", "text-sm text-neutral-200 break-words");
      renderMessage(body, hit.message, hit.spans);
      left.appendChild(body);
      row.appendChild(left);

      const buttons = el("div", "flex items-center gap-1.5 shrink-0");
      const yes = el("button", "", "подходит");
      yes.type = "button";
      yes.className = `aa-yes ${BTN_BASE} ${BTN_IDLE.yes}`;
      const no = el("button", "", "не то");
      no.type = "button";
      no.className = `aa-no ${BTN_BASE} ${BTN_IDLE.no}`;
      buttons.append(yes, no);
      row.appendChild(buttons);

      out.appendChild(row);
      // Прогон можно запустить повторно после правки правила - уже расставленные вердикты
      // живут в текстовых полях и должны пережить перерисовку, иначе разметка сотни строк
      // теряется от одного нажатия «Проверить по логам».
      paintRow(row);
    }
    updateTally(out);

    if (data.nearMissTotal) {
      out.appendChild(
        el("p", "text-amber-400 text-xs mt-4 mb-1", `Гейт вопроса отсёк ещё ${data.nearMissTotal}: слова темы есть, но это не вопрос`)
      );
      for (const miss of data.nearMisses.slice(0, 10)) {
        const row = el("div", "mt-1.5");
        const body = el("p", "text-xs text-neutral-400 break-words");
        renderMessage(body, miss.message, miss.spans);
        row.appendChild(body);
        if (miss.against.length) {
          row.appendChild(el("p", "text-[11px] text-neutral-600", `сумма ${miss.score}/${miss.threshold} · против: ${miss.against.join(" · ")}`));
        }
        out.appendChild(row);
      }
    }
  }

  // --- «не то» на строке журнала живых срабатываний ----------------------------------------

  feed?.addEventListener("click", async (event) => {
    const button = event.target.closest(".aa-reject");
    if (!button || button.disabled) return;

    const row = button.closest("[data-hit]");
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = "…";
    try {
      const data = await post(`/${feed.dataset.channel}/auto-answers/review.json`, {
        _csrf: feed.dataset.csrf,
        id: button.dataset.id,
        review: "false_positive",
      });
      button.textContent = "Помечено";
      row.classList.add("opacity-50");

      // Пометить мало — правило должно перестать это делать. Если после добавления в
      // антипримеры оно всё ещё срабатывает, сервер возвращает конфликт и подсказку, каким
      // словом его закрыть; молча проглотить это значило бы сделать кнопку декоративной.
      const remaining = data.conflictsRemaining;
      if (remaining && remaining.count) {
        row.appendChild(
          el(
            "p",
            "text-amber-400 text-[11px] mt-1",
            remaining.suggested.length
              ? `Помеченных, на которых правило ещё срабатывает: ${remaining.count}. Исключающие слова: ${remaining.suggested.join(", ")}`
              : `Помеченных, на которых правило ещё срабатывает: ${remaining.count} — сузьте правило в редакторе темы.`
          )
        );
      }
    } catch (err) {
      button.disabled = false;
      button.textContent = previous;
    }
  });
})();
