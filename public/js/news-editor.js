// Formatting toolbar for the admin news editor (views/adminNewsForm.ejs) - wraps the current
// textarea selection with Markdown syntax. No WYSIWYG/rich-text dependency: the toolbar just
// inserts the same syntax a Markdown-literate admin would type by hand, so it works identically
// whether or not JS is available to click it. Only meaningful for bodyFormat=markdown, but
// doesn't need to know which format is selected - the HTML-format admin simply won't click it.
(() => {
  const toolbar = document.getElementById("news-editor-toolbar");
  if (!toolbar) return;
  const textarea = document.getElementById(toolbar.dataset.target);
  if (!textarea) return;

  // Wraps the selection in `before`/`after` (or inserts a placeholder if nothing is selected),
  // then restores a selection over the inserted text so repeated clicks (e.g. bold then italic)
  // compose naturally.
  function wrapSelection(before, after, placeholder) {
    const { selectionStart, selectionEnd, value } = textarea;
    const selected = value.slice(selectionStart, selectionEnd) || placeholder;
    const next = value.slice(0, selectionStart) + before + selected + after + value.slice(selectionEnd);
    textarea.value = next;
    const from = selectionStart + before.length;
    textarea.setSelectionRange(from, from + selected.length);
    textarea.focus();
  }

  // Prefixes every selected line (or the current line, with nothing selected) with `prefix`.
  function prefixLines(prefix) {
    const { selectionStart, selectionEnd, value } = textarea;
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    let lineEnd = value.indexOf("\n", selectionEnd);
    if (lineEnd === -1) lineEnd = value.length;
    const block = value.slice(lineStart, lineEnd);
    const prefixed = block
      .split("\n")
      .map((line) => (line.startsWith(prefix) ? line : prefix + line))
      .join("\n");
    textarea.value = value.slice(0, lineStart) + prefixed + value.slice(lineEnd);
    textarea.setSelectionRange(lineStart, lineStart + prefixed.length);
    textarea.focus();
  }

  const ACTIONS = {
    bold: () => wrapSelection("**", "**", "bold text"),
    italic: () => wrapSelection("*", "*", "italic text"),
    heading: () => prefixLines("## "),
    list: () => prefixLines("- "),
    link: () => wrapSelection("[", "](https://)", "link text"),
  };

  toolbar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-md]");
    if (!button) return;
    event.preventDefault();
    const action = ACTIONS[button.dataset.md];
    if (action) action();
  });
})();
