// Клиент страницы /<channel>/auto-answers.
//
// Три кнопки, и все три — прогрессивное улучшение: без JS форма всё равно сохраняется обычным
// POST, а ключевые слова вписываются руками через запятую. Поэтому здесь нет ни одного
// обязательного для работы страницы обработчика.
//
// Тела запросов — urlencoded, а не JSON: приложение не монтирует глобальный express.json()
// (см. app.js), и заводить свой парсер ради трёх ручек, которые прекрасно живут на формах, —
// лишняя деталь. Заголовок Accept: application/json нужен отдельно, чтобы middleware/csrf.js
// отвечал на просроченный токен JSON-ом, а не HTML-страницей ошибки.
//
// Весь пользовательский текст вставляется через textContent. Сообщение из чата — это ввод
// постороннего человека на странице, куда залогинен модератор, и innerHTML здесь означал бы
// XSS ровно того класса, от которого защищается серверный рендер журнала.
(function () {
  "use strict";

  const form = document.getElementById("aa-form");
  const feed = document.getElementById("aa-feed");

  async function post(url, fields) {
    const body = new URLSearchParams(fields);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
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

  /** Подсветить совпавшие слова по спанам, которые вернул матчер. */
  function renderMessage(target, text, spans) {
    let cursor = 0;
    const sorted = (spans || []).slice().sort((a, b) => a.start - b.start);
    for (const span of sorted) {
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

  // --- вывести ключевые слова из примеров -----------------------------------------------

  if (form) {
    const deriveBtn = document.getElementById("aa-derive");
    const note = document.getElementById("aa-derive-note");
    const channel = form.dataset.channel;

    deriveBtn?.addEventListener("click", async () => {
      const examples = document.getElementById("aa-examples").value;
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

    // --- прогон по логам ------------------------------------------------------------------

    const replayBtn = document.getElementById("aa-replay");
    const out = document.getElementById("aa-replay-out");

    replayBtn?.addEventListener("click", async () => {
      replayBtn.disabled = true;
      out.classList.remove("hidden");
      out.replaceChildren(el("p", "text-neutral-500", "Считаю по логам канала…"));
      try {
        const fields = new URLSearchParams(new FormData(form));
        fields.set("days", "30");
        const data = await post(`/${channel}/auto-answers/replay.json`, fields);
        renderReplay(out, data);
      } catch (err) {
        out.replaceChildren(el("p", "text-red-400", "Не удалось: " + err.message));
      } finally {
        replayBtn.disabled = false;
      }
    });
  }

  function renderReplay(out, data) {
    out.replaceChildren();

    const head = el("p", "text-neutral-200 mb-1");
    head.append(
      el("strong", "text-green-400", `Сработало бы ${data.matched} раз`),
      document.createTextNode(` за ${data.days} дн. · в чат ушло бы ${data.wouldSend} (остальное съел бы кулдаун) · спрашивавших: ${data.askers}`)
    );
    out.appendChild(head);

    for (const warning of data.warnings || []) {
      out.appendChild(el("p", "text-amber-400 text-xs mb-1", "⚠ " + warning));
    }

    if (!data.hits.length) {
      out.appendChild(el("p", "text-neutral-500 mt-2", "За этот период ни одного совпадения — правило слишком узкое или вопрос ещё не задавали."));
    }

    for (const hit of data.hits) {
      const row = el("div", "mt-2 pt-2 border-t border-neutral-800/70 flex items-start justify-between gap-3");
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

      // Пометить прямо в результатах прогона, а не только в журнале живых срабатываний:
      // прогон показывает месяц истории сразу, и разметить его за один заход - это и есть
      // самый быстрый способ довести правило до ума, ещё до того как тема кого-то увидит.
      const mark = el("button", "aa-mark shrink-0 px-2 py-1 rounded-md border border-neutral-700 text-neutral-400 hover:border-red-700 hover:text-red-400 text-xs", "не то");
      mark.type = "button";
      mark.dataset.message = hit.message;
      row.appendChild(mark);

      out.appendChild(row);
    }

    if (data.nearMissTotal) {
      const title = el(
        "p",
        "text-amber-400 text-xs mt-4 mb-1",
        `Гейт вопроса отсёк ещё ${data.nearMissTotal}: слова темы есть, но это не вопрос`
      );
      out.appendChild(title);
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

  // --- пометка в результатах прогона + вывод исключающих слов -----------------------------

  if (form) {
    const anti = document.getElementById("aa-anti");
    const out = document.getElementById("aa-replay-out");
    const excludeBtn = document.getElementById("aa-exclusions");
    const excludeNote = document.getElementById("aa-exclusions-note");
    const channel = form.dataset.channel;

    const antiLines = () =>
      anti.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    /** Добавить сообщение в антипримеры, не плодя дублей. */
    function addAnti(message) {
      const lines = antiLines();
      if (lines.includes(message)) return false;
      lines.push(message);
      anti.value = lines.join("\n");
      return true;
    }

    out?.addEventListener("click", (event) => {
      const button = event.target.closest(".aa-mark");
      if (!button || button.disabled) return;
      addAnti(button.dataset.message);
      button.disabled = true;
      button.textContent = "помечено";
      button.className = "shrink-0 px-2 py-1 rounded-md border border-red-800 text-red-400 text-xs opacity-60";
      excludeNote.textContent = `Помечено: ${antiLines().length}. Теперь можно вывести исключающие слова.`;
    });

    excludeBtn?.addEventListener("click", async () => {
      if (!antiLines().length) {
        excludeNote.textContent = "Сначала пометьте кнопкой «не то» хотя бы одно лишнее срабатывание.";
        return;
      }
      excludeBtn.disabled = true;
      excludeNote.textContent = "…";
      try {
        const data = await post(`/${channel}/auto-answers/exclusions.json`, {
          examples: document.getElementById("aa-examples").value,
          antiExamples: anti.value,
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
      // оставить: закрывающее одно сообщение почти всегда подогнано под него одно и лишнее.
      excludeNote.replaceChildren();
      const detail = el("span", "text-neutral-400");
      detail.textContent = data.exclusions.map((e) => `${e.label} (${e.covers})`).join(", ") || "нечего исключать";
      excludeNote.appendChild(detail);
      if (data.warning) {
        excludeNote.appendChild(el("span", "text-amber-400", " ⚠ " + data.warning));
      }
      for (const item of data.uncovered.slice(0, 5)) {
        const line = el("p", "text-[11px] text-neutral-600 mt-1");
        line.textContent = `не закрыто: «${item.text.slice(0, 80)}» — ${item.reason}`;
        excludeNote.appendChild(line);
      }
    }
  }

  // --- «не то» на строке журнала ----------------------------------------------------------

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
      const conflict = (data.conflictsRemaining || []).find((c) => c.text === row.dataset.text);
      const stillFiring = (data.conflictsRemaining || []).length;
      if (stillFiring) {
        const hint = el(
          "p",
          "text-amber-400 text-[11px] mt-1",
          conflict && conflict.suggestedExclude.length
            ? `Правило всё ещё срабатывает. Добавьте исключающее слово: ${conflict.suggestedExclude.join(", ")}`
            : "Правило всё ещё срабатывает на антипримерах — сузьте его в редакторе темы."
        );
        row.appendChild(hint);
      }
    } catch (err) {
      button.disabled = false;
      button.textContent = previous;
    }
  });
})();
