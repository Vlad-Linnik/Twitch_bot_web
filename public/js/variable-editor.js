// Command-text editor: chips for variables, "#" autocomplete, a "# Variable" list, a live preview.
//
// Progressive enhancement over a plain field. Every <textarea>/<input data-variable-editor> stays
// in the form and stays the source of truth: it is what gets submitted, in exactly the grammar the
// server validates and the bot renders (lib/variableTemplate.js, served to the browser as-is by
// lib/sharedScripts.js). Without JS - or if anything here fails to start - the field is simply a
// field.
//
// The editor is a contenteditable <div> drawn from the field's text, and redrawn from it after
// every edit:
//   - text is the template's own source, typed characters included;
//   - a recognised variable is a chip (contenteditable=false) carrying its source in data-src;
//   - an escaped "\#" is a small non-editable span showing "#" and carrying "\#";
//   - the variable the caret is in (or was just typed) stays plain text until the caret leaves,
//     so it can be typed and its parameters edited like any other text.
// Reading the DOM back is "concatenate text and data-src", so the field's value round-trips
// exactly. Caret positions are kept as offsets into that source text.
//
// No innerHTML anywhere: every piece of user or channel text goes in through text nodes.
(function () {
  "use strict";

  const VT = window.VariableTemplate;
  const dataEl = document.getElementById("variable-editor-data");
  if (!VT || !dataEl) return;

  let DATA;
  try {
    DATA = JSON.parse(dataEl.textContent);
  } catch {
    return;
  }

  const NAME_CHAR = /[a-zA-Zа-яА-ЯёЁ0-9_]/;
  const ZWSP = "​";
  const ITEMS = DATA.items || [];
  const OWN_NAMES = ITEMS.filter((i) => i.own).map((i) => i.name);
  const STR = DATA.strings || {};
  const ITEM_BY_NAME = new Map(ITEMS.map((i) => [i.name, i]));

  const fill = (template, vars) =>
    String(template || "").replace(/\{\{(\w+)\}\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- source <-> segments ---------------------------------------------------------------------

  // The template cut into what the editor draws: text (source as typed), lit ("\#"), chip.
  // `activeStart` is the start of the variable being edited, drawn as text.
  function segmentsOf(source, activeStart) {
    const segs = [];
    const pushText = (text) => {
      if (!text) return;
      const last = segs[segs.length - 1];
      if (last && last.type === "text") last.text += text;
      else segs.push({ type: "text", text });
    };
    // Text between variables, with odd backslash runs before "#" pulled out as literal hashes.
    const pushGap = (gap) => {
      const re = /(\\+)#/g;
      let at = 0;
      let m;
      while ((m = re.exec(gap))) {
        if (m[1].length % 2 === 0) continue;
        const hashAt = m.index + m[0].length - 1;
        pushText(gap.slice(at, hashAt - 1));
        segs.push({ type: "lit", src: "\\#" });
        at = hashAt + 1;
      }
      pushText(gap.slice(at));
    };

    let pos = 0;
    for (const tok of VT.tokenize(source)) {
      if (tok.type !== "var") continue;
      pushGap(source.slice(pos, tok.start));
      const check = VT.checkVariable(tok.name, tok.params, OWN_NAMES);
      if (check.kind === "unknown" || tok.start === activeStart) {
        pushText(tok.raw);
      } else {
        segs.push({ type: "chip", src: tok.raw, name: tok.name, params: tok.params, start: tok.start, end: tok.end, check });
      }
      pos = tok.end;
    }
    pushGap(source.slice(pos));
    return segs;
  }

  function varTokenAt(source, offset, { inclusiveEnd = true } = {}) {
    for (const tok of VT.tokenize(source)) {
      if (tok.type !== "var") continue;
      if (tok.start < offset && (inclusiveEnd ? offset <= tok.end : offset < tok.end)) return tok;
    }
    return null;
  }

  // ---- one editor --------------------------------------------------------------------------------

  const nativeDescriptor = (field) =>
    Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");

  function attach(field) {
    if (field.dataset.variableEditorAttached) return;
    field.dataset.variableEditorAttached = "1";

    const full = field.dataset.variableEditor === "full";
    const multiline = field instanceof HTMLTextAreaElement;
    const desc = nativeDescriptor(field);
    const getRaw = () => desc.get.call(field);
    const setRaw = (v) => desc.set.call(field, v);
    const maxLength = Number(field.getAttribute("maxlength")) || VT.MAX_MESSAGE_LENGTH;

    // --- DOM
    const wrap = el("div", "vt-wrap");
    field.parentNode.insertBefore(wrap, field);
    wrap.appendChild(field);
    field.classList.add("vt-source");
    field.tabIndex = -1;
    field.setAttribute("aria-hidden", "true");

    const editor = el("div", `vt-editor ${multiline ? "vt-multi" : "vt-single"}`);
    editor.contentEditable = "true";
    editor.spellcheck = true;
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "false");
    const labelFor = field.id && document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
    if (labelFor) {
      if (!labelFor.id) labelFor.id = `${field.id}-label`;
      editor.setAttribute("aria-labelledby", labelFor.id);
    } else if (field.placeholder) {
      editor.setAttribute("aria-label", field.placeholder);
    }
    if (field.placeholder) editor.dataset.placeholder = field.placeholder;
    wrap.appendChild(editor);

    const insertBtn = el("button", `vt-insert-btn ${full ? "" : "vt-insert-btn-compact"}`, full ? STR.insertButton : "#");
    insertBtn.type = "button";
    insertBtn.title = STR.insertButtonTitle;
    insertBtn.setAttribute("aria-label", STR.insertButtonTitle);
    insertBtn.setAttribute("aria-haspopup", "listbox");
    insertBtn.setAttribute("aria-expanded", "false");

    const popup = el("div", "vt-popup");
    popup.hidden = true;
    const popupList = el("div", "vt-popup-list");
    popupList.setAttribute("role", "listbox");
    popupList.id = `vt-list-${Math.random().toString(36).slice(2, 9)}`;
    const popupDoc = el("div", "vt-popup-doc");
    popup.append(popupList, popupDoc);
    wrap.appendChild(popup);

    let footer = null;
    let previewText = null;
    let lengthEl = null;
    let warningsEl = null;
    if (full) {
      footer = el("div", "vt-footer");
      const previewLine = el("p", "vt-preview");
      previewLine.appendChild(el("span", "vt-preview-label", STR.preview + " "));
      previewText = el("span", "vt-preview-text");
      previewLine.appendChild(previewText);
      lengthEl = el("span", "vt-length");
      const top = el("div", "vt-footer-row");
      top.append(insertBtn, lengthEl);
      warningsEl = el("div", "vt-warnings");
      warningsEl.setAttribute("aria-live", "polite");
      footer.append(top, previewLine, warningsEl);
      wrap.appendChild(footer);
    } else {
      wrap.classList.add("vt-wrap-compact");
      wrap.appendChild(insertBtn);
      warningsEl = el("div", "vt-warnings");
      warningsEl.setAttribute("aria-live", "polite");
      wrap.appendChild(warningsEl);
    }

    // --- state
    let source = getRaw();
    let activeStart = -1; // start of the variable drawn as text while it is being edited
    let composing = false;
    let requiredMessage = "";
    let lastInputType = "";
    let savedCaret = null; // last caret seen while focused, for the "# Variable" list
    const undo = [];
    const redo = [];
    let lastPush = 0;

    // --- DOM <-> source
    function serializeNodes(parent) {
      let out = "";
      parent.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          out += node.data.replace(/​/g, "").replace(/ /g, " ").replace(/[\r\n]+/g, " ");
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.dataset && node.dataset.src !== undefined) out += node.dataset.src;
          else if (node.tagName === "BR") out += "";
          else out += serializeNodes(node);
        }
      });
      return out;
    }

    function pointToOffset(container, offset) {
      const range = document.createRange();
      range.setStart(editor, 0);
      try {
        range.setEnd(container, offset);
      } catch {
        return source.length;
      }
      const frag = range.cloneContents();
      return serializeNodes(frag).length;
    }

    function getSelectionOffsets() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
      return { start: pointToOffset(range.startContainer, range.startOffset), end: pointToOffset(range.endContainer, range.endOffset) };
    }

    // Offset -> a DOM point, always inside a text node (every boundary has one, see draw()).
    function offsetToPoint(offset) {
      let acc = 0;
      const kids = Array.from(editor.childNodes);
      for (let i = 0; i < kids.length; i++) {
        const node = kids[i];
        if (node.nodeType === Node.TEXT_NODE) {
          const data = node.data;
          const target = offset - acc;
          let count = 0;
          for (let k = 0; k <= data.length; k++) {
            if (count === target) return { node, offset: k };
            if (k < data.length && data[k] !== ZWSP) count++;
          }
          acc += count;
        } else {
          const len = (node.dataset && node.dataset.src || "").length;
          if (offset < acc + len) {
            // Inside a chip's source: the nearest side wins.
            const after = offset - acc > len / 2;
            const target = after ? kids[i + 1] : kids[i - 1];
            if (target && target.nodeType === Node.TEXT_NODE) return { node: target, offset: after ? 0 : target.data.length };
            return { node: editor, offset: after ? i + 1 : i };
          }
          acc += len;
        }
      }
      const last = kids[kids.length - 1];
      if (last && last.nodeType === Node.TEXT_NODE) return { node: last, offset: last.data.length };
      return { node: editor, offset: kids.length };
    }

    function setSelectionOffsets(start, end = start) {
      const a = offsetToPoint(start);
      const b = end === start ? a : offsetToPoint(end);
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // --- drawing
    function chipNode(seg) {
      const chip = el("span", "vt-chip");
      chip.contentEditable = "false";
      chip.dataset.src = seg.src;
      chip.dataset.start = String(seg.start);
      const item = ITEM_BY_NAME.get(seg.name);
      if (!seg.check.ok) {
        chip.classList.add("vt-chip-invalid");
        chip.title = fill(STR.invalid && STR.invalid[seg.check.reason], { raw: seg.src });
      } else if (seg.check.kind === "user" && VT.isBuiltin(seg.name)) {
        chip.classList.add("vt-chip-override");
        chip.title = STR.overrides;
      } else if (seg.check.kind === "user") {
        chip.classList.add("vt-chip-own");
        chip.title = item ? item.desc : "";
      } else {
        chip.title = item ? item.desc : "";
      }
      const label = el("span", "vt-chip-label", seg.src);
      label.title = `${chip.title ? chip.title + " · " : ""}${STR.chipEdit}`;
      const lit = el("button", "vt-chip-btn vt-chip-literal", "Aa");
      lit.type = "button";
      lit.tabIndex = -1;
      lit.title = STR.chipLiteral;
      lit.setAttribute("aria-label", `${STR.chipLiteral}: ${seg.src}`);
      lit.dataset.action = "literal";
      const remove = el("button", "vt-chip-btn vt-chip-remove", "×");
      remove.type = "button";
      remove.tabIndex = -1;
      remove.title = STR.chipRemove;
      remove.setAttribute("aria-label", `${STR.chipRemove}: ${seg.src}`);
      remove.dataset.action = "remove";
      chip.append(label, lit, remove);
      return chip;
    }

    function draw() {
      const segs = segmentsOf(source, activeStart);
      const nodes = [];
      segs.forEach((seg) => {
        if (seg.type === "text") nodes.push(document.createTextNode(seg.text));
        else if (seg.type === "lit") {
          const lit = el("span", "vt-lit", "#");
          lit.contentEditable = "false";
          lit.dataset.src = seg.src;
          nodes.push(lit);
        } else nodes.push(chipNode(seg));
      });
      // A caret can only sit in text: every non-text node gets a text neighbour on both sides
      // (an empty-looking zero-width space where there is no real text).
      const padded = [];
      nodes.forEach((node, i) => {
        const prev = padded[padded.length - 1];
        if (node.nodeType !== Node.TEXT_NODE && (!prev || prev.nodeType !== Node.TEXT_NODE)) padded.push(document.createTextNode(ZWSP));
        padded.push(node);
        if (i === nodes.length - 1 && node.nodeType !== Node.TEXT_NODE) padded.push(document.createTextNode(ZWSP));
      });
      editor.replaceChildren(...padded);
    }

    // --- side panels
    function updateFooter() {
      if (!warningsEl) return;
      const warnings = [];
      const tokens = VT.tokenize(source);
      if (requiredMessage && !source.trim()) warnings.push({ cls: "vt-warning-invalid", text: requiredMessage });
      else requiredMessage = "";
      for (const p of VT.validateTemplate(source, OWN_NAMES)) {
        warnings.push({ cls: "vt-warning-invalid", text: fill(STR.invalid && STR.invalid[p.reason], { raw: p.raw }) });
      }
      if (full) {
        const timerField = DATA.timerFieldId && document.getElementById(DATA.timerFieldId);
        const timerOn = timerField && String(timerField.value || "").trim() !== "" && String(timerField.value) !== "0";
        if (timerOn) {
          const names = [];
          for (const tok of tokens) {
            if (tok.type !== "var") continue;
            const check = VT.checkVariable(tok.name, tok.params, OWN_NAMES);
            if (check.kind === "builtin" && VT.BUILTINS[tok.name].perCaller && !names.includes(`#${tok.name}`)) names.push(`#${tok.name}`);
          }
          if (names.length) warnings.push({ cls: "vt-warning-timer", text: fill(STR.timerWarning, { names: names.join(", ") }) });
        }
        const length = Array.from(source).length;
        lengthEl.textContent = fill(STR.length, { n: length, max: maxLength });
        lengthEl.classList.toggle("vt-length-over", length > maxLength);
        if (length > maxLength) warnings.push({ cls: "vt-warning-invalid", text: fill(STR.tooLong, { max: maxLength }) });
        const preview = renderPreview(tokens);
        previewText.textContent = preview || STR.previewEmpty;
        previewText.classList.toggle("vt-preview-empty", !preview);
      }
      warningsEl.replaceChildren(...warnings.map((w) => el("p", `vt-warning ${w.cls}`, w.text)));
    }

    function renderPreview(tokens) {
      const samples = DATA.samples || {};
      const values = {};
      ITEMS.filter((i) => i.own).forEach((i) => (values[i.name] = i.value));
      const now = new Date();
      const out = VT.render(tokens, (name, params) => {
        const check = VT.checkVariable(name, params, OWN_NAMES);
        if (!check.ok || check.kind === "unknown") return undefined;
        if (check.kind === "user") return String(values[name]);
        const orFallback = (v) => (v ? v : params || "");
        switch (name) {
          case "rand": {
            const { min, max } = VT.parseRange(params);
            return String(min + Math.floor(Math.random() * (max - min + 1)));
          }
          case "pick": {
            const options = VT.parsePick(params);
            return options[Math.floor(Math.random() * options.length)];
          }
          case "time":
            return now.toLocaleTimeString(document.documentElement.lang || undefined, { hour: "2-digit", minute: "2-digit" });
          case "date":
            return now.toLocaleDateString(document.documentElement.lang || undefined, { day: "numeric", month: "long", year: "numeric" });
          default:
            return orFallback(samples[name] || "");
        }
      });
      return out.replace(/\s{2,}/g, " ").trim();
    }

    // --- writes
    function syncField() {
      if (getRaw() === source) return;
      setRaw(source);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function remember() {
      lastPush = 0;
      const sel = getSelectionOffsets();
      undo.push({ source, caret: sel ? sel.end : source.length });
      if (undo.length > 200) undo.shift();
      redo.length = 0;
    }

    // Replaces [start, end) of the source and leaves the selection at [selStart, selEnd).
    function replaceRange(start, end, text, selStart, selEnd) {
      remember();
      source = source.slice(0, start) + text + source.slice(end);
      const caretStart = selStart ?? start + text.length;
      const caretEnd = selEnd ?? caretStart;
      const tok = varTokenAt(source, caretEnd);
      activeStart = tok && caretStart > tok.start && caretEnd <= tok.end && selStart !== undefined ? tok.start : -1;
      commit(caretStart, caretEnd);
    }

    function commit(selStart, selEnd = selStart) {
      draw();
      if (document.activeElement === editor && selStart !== null && selStart !== undefined) setSelectionOffsets(selStart, selEnd);
      syncField();
      updateFooter();
    }

    // Re-reads the DOM after the browser edited it, then redraws.
    function onEdited() {
      const before = source;
      const sel = getSelectionOffsets();
      const next = serializeNodes(editor);
      if (next === before) return;
      // Typing is undone a burst at a time, not a letter at a time.
      if (!undo.length || Date.now() - lastPush > 800) undo.push({ source: before, caret: sel ? sel.end : next.length });
      lastPush = Date.now();
      redo.length = 0;
      source = next;
      const caret = sel ? sel.end : source.length;
      // Typing opens the variable it lands in (or right after) for editing. Deleting does so only
      // from strictly inside one: Backspace that removes the space after a chip must leave the
      // chip a chip, so the next Backspace takes it whole.
      const typed = !/^delete/.test(lastInputType);
      const tok = typed ? varTokenAt(source, caret) : varTokenAt(source, caret, { inclusiveEnd: false });
      const keep = !typed && activeStart !== -1 && varTokenAt(source, caret);
      activeStart = tok ? tok.start : keep && keep.start === activeStart ? activeStart : -1;
      commit(caret);
      updatePopupForTyping(caret);
    }

    function restore(from, to) {
      const state = from.pop();
      if (!state) return;
      to.push({ source, caret: (getSelectionOffsets() || { end: source.length }).end });
      source = state.source;
      activeStart = -1;
      commit(Math.min(state.caret, source.length));
      closePopup();
    }

    function literalize(tok) {
      replaceRange(tok.start, tok.start, "\\", tok.end + 1);
      activeStart = -1;
      commit(tok.end + 1);
    }

    // --- external value changes (an "edit" button filling the form, form.reset())
    Object.defineProperty(field, "value", {
      configurable: true,
      get: getRaw,
      set(v) {
        setRaw(v);
        source = getRaw();
        activeStart = -1;
        undo.length = 0;
        redo.length = 0;
        draw();
        updateFooter();
      },
    });
    if (field.form) {
      field.form.addEventListener("reset", () => {
        setTimeout(() => {
          source = getRaw();
          activeStart = -1;
          draw();
          updateFooter();
        });
      });
    }
    field.addEventListener("focus", () => {
      editor.focus();
      setSelectionOffsets(source.length);
    });
    // The browser's own "required" check targets the hidden field: its bubble would point at an
    // invisible 1px box. Its message is shown under the editor instead, and focus goes there.
    field.addEventListener("invalid", (event) => {
      event.preventDefault();
      requiredMessage = field.validationMessage;
      editor.classList.add("vt-invalid");
      updateFooter();
      setTimeout(() => {
        editor.focus();
        setSelectionOffsets(source.length);
      });
    });

    // --- events
    editor.addEventListener("compositionstart", () => (composing = true));
    editor.addEventListener("compositionend", () => {
      composing = false;
      onEdited();
    });
    editor.addEventListener("input", (event) => {
      editor.classList.remove("vt-invalid");
      if (composing || event.isComposing) return;
      onEdited();
    });

    editor.addEventListener("beforeinput", (event) => {
      const type = event.inputType || "";
      lastInputType = type;
      if (type === "insertParagraph" || type === "insertLineBreak" || type.startsWith("format")) {
        event.preventDefault();
        return;
      }
      if (type === "historyUndo" || type === "historyRedo") {
        event.preventDefault();
        if (type === "historyUndo") restore(undo, redo);
        else restore(redo, undo);
        return;
      }
      // A chip right next to a collapsed caret goes in one keypress (Backspace before it, Delete
      // after it). Done here rather than on keydown: mobile keyboards often send no usable key.
      if (type === "deleteContentBackward" || type === "deleteContentForward") {
        const sel = getSelectionOffsets();
        if (!sel || sel.start !== sel.end) return;
        const at = sel.start;
        const segs = segmentsOf(source, activeStart);
        let pos = 0;
        for (const seg of segs) {
          const len = (seg.text || seg.src).length;
          if (seg.type !== "text") {
            const hit = type === "deleteContentBackward" ? pos + len === at : pos === at;
            if (hit) {
              event.preventDefault();
              activeStart = -1;
              replaceRange(pos, pos + len, "", pos, pos);
              activeStart = -1;
              commit(pos);
              closePopup();
              return;
            }
          }
          pos += len;
        }
      }
    });

    editor.addEventListener("keydown", (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "b" || key === "i" || key === "u") {
          event.preventDefault();
          return;
        }
        if (key === "z" || key === "y" || key === "я" || key === "н") {
          event.preventDefault();
          if ((key === "z" || key === "я") && !event.shiftKey) restore(undo, redo);
          else restore(redo, undo);
          return;
        }
      }
      if (!popup.hidden) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveHighlight(event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = currentItems[highlighted];
          if (item) {
            event.preventDefault();
            insertFromPopup(item);
            return;
          }
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          const sel = getSelectionOffsets();
          const tok = sel && varTokenAt(source, sel.end);
          dismissedAnchor = popupAnchor;
          closePopup();
          if (tok && VT.checkVariable(tok.name, tok.params, OWN_NAMES).kind !== "unknown") literalize(tok);
          return;
        }
      }
      // Inside the parameters of the variable being edited (where a pick from the list leaves the
      // caret, on the selected example), Tab or Enter jumps past its ")" and finishes it, and a
      // typed ")" steps over the one already there - the way a code editor leaves a snippet.
      if (activeStart !== -1 && (event.key === "Tab" || event.key === "Enter" || event.key === ")") && !event.shiftKey && !mod) {
        const sel = getSelectionOffsets();
        const tok = sel && varTokenAt(source, sel.end);
        const inParams = tok && tok.start === activeStart && tok.params !== null && sel.end < tok.end;
        if (inParams && (event.key !== ")" || (sel.start === sel.end && source[sel.end] === ")" && sel.end === tok.end - 1))) {
          event.preventDefault();
          activeStart = -1;
          commit(tok.end);
          return;
        }
      }
      if (event.key === "Enter") {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        // The variable being edited, if any, is kept as text; otherwise Escape is the dialog's.
        const sel = getSelectionOffsets();
        const tok = sel && activeStart !== -1 && varTokenAt(source, sel.end);
        if (tok && VT.checkVariable(tok.name, tok.params, OWN_NAMES).kind !== "unknown") {
          event.preventDefault();
          event.stopPropagation();
          literalize(tok);
        }
        return;
      }
      // Arrow keys step INTO a chip instead of over it, so its parameters can be edited (and it
      // can be kept as text with Escape) without a mouse.
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey && !mod && !event.altKey) {
        const sel = getSelectionOffsets();
        if (!sel || sel.start !== sel.end) return;
        const tokens = VT.tokenize(source).filter((t) => t.type === "var" && t.start !== activeStart && VT.checkVariable(t.name, t.params, OWN_NAMES).kind !== "unknown");
        const tok = event.key === "ArrowLeft" ? tokens.find((t) => t.end === sel.start) : tokens.find((t) => t.start === sel.start);
        if (tok) {
          event.preventDefault();
          activeStart = tok.start;
          commit(event.key === "ArrowLeft" ? tok.end - 1 : tok.start + 1);
        }
      }
    });

    document.addEventListener("selectionchange", () => {
      if (document.activeElement !== editor || composing) return;
      const sel = getSelectionOffsets();
      if (!sel) return;
      savedCaret = sel.end;
      if (activeStart !== -1) {
        const tok = varTokenAt(source, sel.end);
        const stillInside = tok && tok.start === activeStart && sel.start > tok.start;
        if (!stillInside) {
          activeStart = -1;
          draw();
          setSelectionOffsets(sel.start, sel.end);
        }
      }
      if (!popup.hidden && (popupAnchor === null || sel.end <= popupAnchor || !/^#[a-zA-Zа-яА-ЯёЁ0-9_]*$/.test(source.slice(popupAnchor, sel.end)))) {
        closePopup();
      }
    });

    editor.addEventListener("blur", () => {
      // Where the caret was when focus left is where the "# Variable" list inserts. Read now,
      // while the selection still points into the editor.
      const sel = getSelectionOffsets();
      if (sel) savedCaret = sel.end;
      // Leaving the field finishes whatever variable was being typed.
      setTimeout(() => {
        if (document.activeElement === editor) return;
        if (!popup.contains(document.activeElement)) closePopup();
        if (activeStart !== -1) {
          activeStart = -1;
          draw();
        }
      }, 0);
    });

    editor.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = (event.clipboardData && event.clipboardData.getData("text/plain")) || "";
      const clean = text.replace(/\s*[\r\n]+\s*/g, " ");
      const sel = getSelectionOffsets() || { start: source.length, end: source.length };
      activeStart = -1;
      replaceRange(sel.start, sel.end, clean);
      activeStart = -1;
      commit(sel.start + clean.length);
    });
    const copySelection = (event, cut) => {
      const sel = window.getSelection();
      const offsets = getSelectionOffsets();
      if (!sel || !sel.rangeCount || !offsets || offsets.start === offsets.end) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", source.slice(offsets.start, offsets.end));
      if (cut) {
        activeStart = -1;
        replaceRange(offsets.start, offsets.end, "", offsets.start, offsets.start);
      }
    };
    editor.addEventListener("copy", (event) => copySelection(event, false));
    editor.addEventListener("cut", (event) => copySelection(event, true));
    editor.addEventListener("drop", (event) => event.preventDefault());
    editor.addEventListener("dragstart", (event) => event.preventDefault());

    // Chip clicks: the two buttons, or the chip itself to edit it as text.
    editor.addEventListener("mousedown", (event) => {
      if (event.target.closest(".vt-chip")) event.preventDefault();
    });
    editor.addEventListener("click", (event) => {
      const chip = event.target.closest(".vt-chip");
      if (!chip) return;
      event.preventDefault();
      const start = Number(chip.dataset.start);
      const tok = VT.tokenize(source).find((t) => t.type === "var" && t.start === start);
      if (!tok) return;
      editor.focus();
      const action = event.target.closest("[data-action]");
      if (action && action.dataset.action === "remove") {
        activeStart = -1;
        replaceRange(tok.start, tok.end, "", tok.start, tok.start);
        activeStart = -1;
        commit(tok.start);
      } else if (action && action.dataset.action === "literal") {
        literalize(tok);
      } else {
        activeStart = tok.start;
        commit(tok.end);
      }
    });

    // --- the list (autocomplete popup and the "# Variable" button share it)
    let currentItems = [];
    let highlighted = 0;
    let popupAnchor = null; // source offset of the "#" being completed; null for the button list
    let dismissedAnchor = null;
    let popupMode = "complete";

    function matchItems(query) {
      const q = query.toLowerCase();
      if (!q) return ITEMS.slice();
      const prefix = ITEMS.filter((i) => i.name.startsWith(q));
      const inside = ITEMS.filter((i) => !i.name.startsWith(q) && i.name.includes(q));
      return prefix.concat(inside);
    }

    function showDoc(item) {
      popupDoc.replaceChildren();
      if (!item) return;
      popupDoc.appendChild(el("p", "vt-doc-name", `#${item.name}`));
      if (item.desc) popupDoc.appendChild(el("p", "vt-doc-desc", item.desc));
      if (item.example) popupDoc.appendChild(el("p", "vt-doc-example", `${STR.exampleLabel} ${item.example}`));
    }

    function renderList(items, grouped) {
      currentItems = items;
      popupList.replaceChildren();
      if (!items.length) {
        popupList.appendChild(el("p", "vt-popup-empty", STR.noMatches));
        showDoc(null);
        return;
      }
      let lastGroup = null;
      items.forEach((item, index) => {
        if (grouped && item.group !== lastGroup) {
          const group = (DATA.groups || []).find((g) => g.key === item.group);
          popupList.appendChild(el("p", "vt-popup-group", group ? group.label : item.group));
          lastGroup = item.group;
        }
        const option = el("button", "vt-option");
        option.type = "button";
        option.setAttribute("role", "option");
        option.id = `${popupList.id}-${index}`;
        option.dataset.index = String(index);
        option.tabIndex = popupMode === "button" ? 0 : -1;
        option.appendChild(el("span", "vt-option-name", `#${item.name}`));
        const hint = item.own ? String(item.value) : (DATA.groups || []).find((g) => g.key === item.group)?.label || "";
        option.appendChild(el("span", "vt-option-hint", hint));
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("mouseenter", () => setHighlight(index, false));
        option.addEventListener("focus", () => setHighlight(index, false));
        option.addEventListener("click", () => (popupMode === "button" ? insertFromButton(item) : insertFromPopup(item)));
        popupList.appendChild(option);
      });
      setHighlight(0, false);
    }

    function setHighlight(index, scroll) {
      highlighted = Math.max(0, Math.min(index, currentItems.length - 1));
      popupList.querySelectorAll(".vt-option").forEach((node) => {
        const on = Number(node.dataset.index) === highlighted;
        node.classList.toggle("vt-option-active", on);
        node.setAttribute("aria-selected", on ? "true" : "false");
        if (on && scroll) node.scrollIntoView({ block: "nearest" });
      });
      if (popupMode === "complete") editor.setAttribute("aria-activedescendant", `${popupList.id}-${highlighted}`);
      showDoc(currentItems[highlighted]);
    }

    function moveHighlight(delta) {
      if (!currentItems.length) return;
      setHighlight((highlighted + delta + currentItems.length) % currentItems.length, true);
      if (popupMode === "button") {
        const node = popupList.querySelector(`.vt-option[data-index="${highlighted}"]`);
        if (node) node.focus();
      }
    }

    function placePopup() {
      popup.style.top = "";
      popup.style.left = "";
      if (popupMode !== "complete") {
        popup.classList.add("vt-popup-under");
        return;
      }
      popup.classList.remove("vt-popup-under");
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const caretRect = sel.getRangeAt(0).getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      if (!caretRect || (!caretRect.width && !caretRect.height && !caretRect.top)) return;
      const left = Math.max(0, Math.min(caretRect.left - wrapRect.left, wrapRect.width - popup.offsetWidth));
      popup.style.left = `${left}px`;
      popup.style.top = `${caretRect.bottom - wrapRect.top + 4}px`;
    }

    function openPopup(mode, items) {
      popupMode = mode;
      popup.hidden = false;
      popup.classList.toggle("vt-popup-button", mode === "button");
      renderList(items, mode === "button");
      placePopup();
      if (mode === "complete") {
        editor.setAttribute("aria-controls", popupList.id);
      } else {
        insertBtn.setAttribute("aria-expanded", "true");
      }
    }

    function closePopup() {
      if (popup.hidden) return;
      popup.hidden = true;
      popupAnchor = null;
      editor.removeAttribute("aria-activedescendant");
      insertBtn.setAttribute("aria-expanded", "false");
    }

    // After typing: is the caret right after an unescaped "#name-so-far"?
    function updatePopupForTyping(caret) {
      const before = source.slice(0, caret);
      const m = before.match(/#([a-zA-Zа-яА-ЯёЁ0-9_]*)$/);
      if (!m) {
        closePopup();
        return;
      }
      const hashAt = caret - m[0].length;
      let slashes = 0;
      while (source[hashAt - 1 - slashes] === "\\") slashes++;
      if (slashes % 2 === 1 || hashAt === dismissedAnchor) {
        closePopup();
        return;
      }
      if (dismissedAnchor !== null && hashAt !== dismissedAnchor) dismissedAnchor = null;
      popupAnchor = hashAt;
      openPopup("complete", matchItems(m[1]));
    }

    // The source range a pick replaces: the "#" and the whole name around the caret.
    function completionRange() {
      let end = popupAnchor + 1;
      while (end < source.length && NAME_CHAR.test(source[end])) end++;
      return { start: popupAnchor, end };
    }

    // A pick glued to a following letter would read as a different name: empty parentheses
    // close it ("#username()раз"), the grammar's own way of doing that.
    function snippetAt(item, end) {
      const next = source[end] || "";
      const glue = !item.select && (NAME_CHAR.test(next) || next === "(") ? "()" : "";
      return item.insert + glue;
    }

    function insertItem(item, start, end) {
      const text = snippetAt(item, end);
      if (item.select) replaceRange(start, end, text, start + item.select[0], start + item.select[1]);
      else {
        activeStart = -1;
        replaceRange(start, end, text);
        activeStart = -1;
        commit(start + text.length);
      }
    }

    function insertFromPopup(item) {
      if (popupAnchor === null) return;
      const { start, end } = completionRange();
      closePopup();
      insertItem(item, start, end);
    }

    function insertFromButton(item) {
      closePopup();
      editor.focus();
      const at = savedCaret === null ? source.length : Math.min(savedCaret, source.length);
      // Not inside another variable's source: after it.
      const inside = varTokenAt(source, at, { inclusiveEnd: false });
      let pos = inside ? inside.end : at;
      // Picked from a list, not typed: it lands as its own word.
      if (pos > 0 && !/\s/.test(source[pos - 1])) {
        replaceRange(pos, pos, " ");
        pos += 1;
      }
      insertItem(item, pos, pos);
    }

    insertBtn.addEventListener("mousedown", () => {
      const sel = getSelectionOffsets();
      if (sel) savedCaret = sel.end;
    });
    insertBtn.addEventListener("click", () => {
      if (!popup.hidden && popupMode === "button") {
        closePopup();
        return;
      }
      openPopup("button", ITEMS.slice());
      const first = popupList.querySelector(".vt-option");
      if (first) first.focus();
    });
    popup.addEventListener("keydown", (event) => {
      if (popupMode !== "button") return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePopup();
        insertBtn.focus();
      } else if (event.key === "Tab") {
        closePopup();
      }
    });
    document.addEventListener("mousedown", (event) => {
      if (!popup.hidden && !wrap.contains(event.target)) closePopup();
    });

    const timerField = DATA.timerFieldId && document.getElementById(DATA.timerFieldId);
    if (full && timerField) timerField.addEventListener("input", updateFooter);

    if (full) {
      const hint = wrap.parentNode.querySelector("[data-variable-hint]");
      if (hint) hint.hidden = true;
    }

    // What would make the server refuse this text: a known variable with parameters it does not
    // take, or a template over the length limit. Checked before submitting (see below), so the
    // mod is pointed at the orange chip instead of losing the form to an error page.
    EDITORS.push({
      field,
      blocked() {
        return VT.validateTemplate(source, OWN_NAMES).length > 0 || Array.from(source).length > maxLength;
      },
      point() {
        editor.classList.add("vt-invalid");
        updateFooter();
        editor.focus();
        setSelectionOffsets(source.length);
        (warningsEl || editor).scrollIntoView({ behavior: "smooth", block: "center" });
      },
    });

    draw();
    updateFooter();
  }

  const EDITORS = [];

  // Capture phase on the document runs before any submit listener on the form itself, so a
  // refused text never reaches the page's own save logic.
  document.addEventListener("submit", (event) => {
    const bad = EDITORS.find((e) => e.field.form === event.target && document.contains(e.field) && e.blocked());
    if (!bad) return;
    event.preventDefault();
    event.stopPropagation();
    bad.point();
  }, true);

  function attachAll(root) {
    root.querySelectorAll("[data-variable-editor]").forEach((field) => {
      try {
        attach(field);
      } catch (err) {
        // A field the editor failed to take over is still a working field.
        console.error("[variable-editor]", err);
      }
    });
  }

  attachAll(document);
  // Rows added later (the per-category texts) get an editor as they appear.
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        // The editors' own redraws are not new fields.
        if (node.closest(".vt-editor, .vt-popup")) return;
        if (node.matches && node.matches("[data-variable-editor]")) attachAll(node.parentNode);
        else attachAll(node);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
