// Comment thread interactivity (views/partials/commentThread.ejs): reply-form toggling,
// up/down vote buttons, collapsing long comment bodies behind a "read more" toggle,
// incrementally loading more root-level comment threads, an emote-aware comment editor, and
// (further below) fetch-based posting + sort-switching, so none of the common actions on this
// page ever reload it or move the visitor's scroll position. Every one of these still has a
// real, working no-JS fallback (a plain form submit / a real <a href>) - this file only
// intercepts and short-circuits them when it can, never removes the underlying capability.
//
// Content inserted after page load (via "load more", a sort switch, or posting a comment/reply)
// needs the exact same follow-up wiring a freshly-loaded page gets - see bindCommentSubtree()
// below, which every insertion point funnels through instead of re-deriving it three times.

// Long-comment collapse: a pure display enhancement, not a data guarantee - lib/commentEmotes.js
// already rendered the full body into the DOM (data-comment-text), so with JS disabled every
// comment just renders at full length instead of being stuck collapsed. Measuring scrollHeight
// against a fixed pixel cap (rather than counting characters server-side) accounts for emote
// <img> tags and font/wrapping differences without needing the server to guess rendered height.
function initReadMore(root) {
  const COLLAPSE_HEIGHT_PX = 168; // ~7 lines of body text before a "read more" appears

  for (const el of root.querySelectorAll("[data-comment-text]")) {
    if (el.scrollHeight <= COLLAPSE_HEIGHT_PX + 8) continue;

    el.classList.add("news-comment-collapsed");
    const readMoreText = el.dataset.readmoreText || "";
    const readLessText = el.dataset.readlessText || "";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "news-comment-readmore text-xs font-medium text-purple-400 hover:text-purple-300 mt-1";
    toggle.textContent = readMoreText;
    toggle.addEventListener("click", () => {
      const collapsed = el.classList.toggle("news-comment-collapsed");
      toggle.textContent = collapsed ? readMoreText : readLessText;
    });
    el.after(toggle);
  }
}

initReadMore(document);

// Reply toggle: show/hide the hidden reply form directly under the clicked comment. Multiple
// reply boxes can be open at once - not tracking "which one" adds no real value here. Delegated
// on document, so it works for comments loaded later by "load more" too.
(() => {
  document.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-reply-toggle]");
    if (!toggle) return;
    const body = toggle.closest("[data-comment-body]");
    const form = body?.querySelector(":scope > [data-reply-form]");
    if (!form) return;
    form.hidden = !form.hidden;
    // The visible, focusable control is the enhanced editor div once JS has run; only a
    // textarea that failed enhancement (or never got the chance to) is focusable directly.
    if (!form.hidden) (form.querySelector("[data-comment-editor]") || form.querySelector("[data-comment-input]"))?.focus();
  });
})();

// Vote buttons: three-state per comment (none/up/down) - clicking the active arrow again undoes
// it, clicking the other one switches. Both arrows on a comment share one data-comment-id, so a
// single fetch response updates both buttons' data-voted plus the shared score span. Delegated
// on document (not a one-time querySelectorAll loop) so buttons on comments loaded later by
// "load more" work without any extra rebinding step.
(() => {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-comment-vote]");
    if (!button || button.disabled || button.dataset.busy === "1") return;

    const { commentId, channel, direction, csrf } = button.dataset;
    if (!csrf) {
      const returnTo = window.location.pathname + window.location.search;
      window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
      return;
    }

    const pair = document.querySelectorAll(`[data-comment-vote][data-comment-id="${commentId}"]`);
    // Both vote buttons and the score span are siblings in the same vote-column div.
    const scoreEl = button.parentElement.querySelector(".news-comment-score");
    if (!scoreEl) return;

    button.dataset.busy = "1";
    try {
      const response = await fetch(`/${channel}/news/comments/${commentId}/vote`, {
        method: "POST",
        body: new URLSearchParams({ direction, _csrf: csrf }),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = await response.json();
      scoreEl.textContent = String(body.score);
      for (const btn of pair) {
        const btnDirection = parseInt(btn.dataset.direction, 10);
        btn.dataset.voted = body.value === btnDirection ? "1" : "0";
      }
    } catch {
      // No optimistic flip to roll back here (unlike news-reactions.js) - a vote has three
      // possible resulting states depending on what was there before, so this just leaves the
      // UI as-is on failure rather than guessing; the next click retries against the real state.
    } finally {
      button.dataset.busy = "0";
    }
  });
})();

// --- Emote-aware comment editor ---------------------------------------------------------------
// Upgrades each plain <textarea data-comment-input> into a contenteditable box that shows
// recognized emote names as their actual image INLINE, live, while still typing - not a
// secondary preview panel. The textarea itself never goes away: it's hidden (not removed) and
// kept perfectly in sync with the editor's plain-text content on every change, so it stays the
// thing that actually submits (progressive enhancement - a visitor with JS disabled just gets
// the plain textarea, unchanged from before this feature existed).
//
// The core trick is a full wipe-and-rebuild on every change rather than surgical DOM edits:
// serialize the editor's current content to plain text, re-tokenize it against the channel's
// emote list (emoteMatch.js's tokenizeForPreview - the same whole-token-match rule the server
// uses to render posted comments), rebuild the editor's children from that (Text nodes + <img
// contenteditable="false"> for matched tokens), then restore the caret to the equivalent text
// offset. This is what makes the feature self-healing against contenteditable's usual cross-
// browser mess (e.g. a stray wrapper element some browser's default Enter-key handling might
// produce): whatever the DOM looked like for one frame, the very next rebuild normalizes it back
// to "only text and our own emote <img> nodes" - so ENTER and PASTE are also intercepted and
// routed through the same rebuild pipeline rather than left to each browser's own contenteditable
// behavior, which is where the well-known cross-browser inconsistencies live.
//
// A DOM (node, offset) position is converted to/from a plain-text offset via the Range API
// (getEditorCaretOffset/findEditorPositionAtOffset) rather than hand-walking node types, since
// Range.cloneContents() already resolves every edge case (a boundary inside a text node vs. a
// bare child-index boundary on the container) correctly on its own.

// Recognizes exactly the two node shapes rebuildEditorFromText() ever produces: #text, and our
// own <img data-emote-name>. Anything else (a stray element from some unexpected paste/composition
// artifact) is unwrapped recursively rather than dropped, so no typed text is ever silently lost.
function serializeEditorText(node) {
  let text = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      text += child.tagName === "IMG" ? child.dataset.emoteName || "" : serializeEditorText(child);
    }
  }
  return text;
}

function measureFragmentTextLength(node) {
  let total = 0;
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      total += child.textContent.length;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      total += child.tagName === "IMG" ? (child.dataset.emoteName || "").length : measureFragmentTextLength(child);
    }
  }
  return total;
}

// Plain-text offset of the current caret within `root`'s serialized content, or null if the
// selection isn't inside `root` at all (e.g. focus moved elsewhere between event and handler).
function getEditorCaretOffset(root) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;

  const measuring = document.createRange();
  measuring.selectNodeContents(root);
  measuring.setEnd(range.startContainer, range.startOffset);
  return measureFragmentTextLength(measuring.cloneContents());
}

// Inverse of getEditorCaretOffset: the (node, offset) Range boundary inside the ACTUAL (already
// rebuilt) `root` that corresponds to plain-text offset `targetOffset`.
function findEditorPositionAtOffset(root, targetOffset) {
  const children = [...root.childNodes];
  let remaining = targetOffset;
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) {
      const len = child.textContent.length;
      if (remaining <= len) return { node: child, offset: remaining };
      remaining -= len;
    } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === "IMG") {
      const len = (child.dataset.emoteName || "").length;
      // The image is an atomic unit - a target offset landing anywhere within its span (not just
      // at its very start) still parks the caret immediately BEFORE it, never "inside" it.
      if (remaining <= 0) return { node: root, offset: children.indexOf(child) };
      remaining -= len;
    }
  }
  return { node: root, offset: children.length };
}

function setEditorCaretOffset(root, targetOffset) {
  const pos = findEditorPositionAtOffset(root, Math.max(0, targetOffset));
  const range = document.createRange();
  range.setStart(pos.node, pos.offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function rebuildEditorFromText(root, text, emoteIndex) {
  root.textContent = "";
  for (const token of EmoteMatch.tokenizeForPreview(text, emoteIndex)) {
    if (token.type === "emote") {
      const img = document.createElement("img");
      img.src = token.url;
      img.alt = token.name;
      img.title = token.name;
      img.draggable = false;
      img.contentEditable = "false";
      img.dataset.emoteName = token.name;
      img.className = "inline-block h-6 w-auto align-text-bottom mx-0.5";
      root.appendChild(img);
    } else if (token.value !== "") {
      root.appendChild(document.createTextNode(token.value));
    }
  }
}

function enhanceCommentTextarea(textarea, emoteList, emoteIndex) {
  if (textarea.dataset.emoteBound === "1") return;
  textarea.dataset.emoteBound = "1";

  try {
    const wrap = textarea.parentElement;
    const suggestionsEl = wrap.querySelector("[data-emote-suggestions]");

    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.dataset.commentEditor = "1";
    editor.className = `${textarea.className} whitespace-pre-wrap break-words overflow-y-auto`;
    // Reply-form textareas start out inside a hidden (display:none) parent, where offsetHeight
    // always reads 0 - so this is sized off the `rows` attribute instead of the rendered height,
    // which stays meaningful regardless of whether the textarea was ever visible at bind time.
    editor.style.minHeight = `${(parseInt(textarea.rows, 10) || 2) * 1.75}rem`;
    if (textarea.placeholder) editor.dataset.placeholder = textarea.placeholder;
    if (textarea.value) rebuildEditorFromText(editor, textarea.value, emoteIndex);

    let activeMatches = [];
    let highlighted = 0;
    let tokenStart = 0;
    let tokenEnd = 0;

    function closeSuggestions() {
      activeMatches = [];
      highlighted = 0;
      if (suggestionsEl) {
        suggestionsEl.hidden = true;
        suggestionsEl.textContent = "";
      }
    }

    function renderSuggestions() {
      if (!suggestionsEl) return;
      suggestionsEl.textContent = "";
      activeMatches.forEach((emote, index) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className =
          "w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm " +
          (index === highlighted ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800");

        const img = document.createElement("img");
        img.src = emote.url;
        img.alt = "";
        img.className = "h-5 w-auto shrink-0";

        const label = document.createElement("span");
        label.textContent = emote.name;

        item.append(img, label);
        item.addEventListener("mouseenter", () => {
          highlighted = index;
          renderSuggestions();
        });
        // mousedown, not click - fires before the editor's blur, same trick
        // statistics-chat.js's user-search suggestions use for the same reason.
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          applyCompletion(emote);
        });
        suggestionsEl.appendChild(item);
      });
      suggestionsEl.hidden = activeMatches.length === 0;
    }

    // The textarea's own maxlength attribute still applies - a contenteditable div has no native
    // equivalent, so it's enforced here instead, at the one point every mutation (typing, paste,
    // Enter, tab-complete) already funnels through.
    function rebuild(text, caretOffset) {
      let nextText = text;
      let nextCaret = caretOffset;
      if (textarea.maxLength > 0 && nextText.length > textarea.maxLength) {
        nextText = nextText.slice(0, textarea.maxLength);
        nextCaret = nextCaret === null ? null : Math.min(nextCaret, nextText.length);
      }
      rebuildEditorFromText(editor, nextText, emoteIndex);
      if (nextCaret !== null) setEditorCaretOffset(editor, nextCaret);
      textarea.value = nextText;
    }

    function updateSuggestionsFromCaret() {
      const offset = getEditorCaretOffset(editor);
      if (offset === null) {
        closeSuggestions();
        return;
      }
      const current = EmoteMatch.getCurrentToken(serializeEditorText(editor), offset);
      tokenStart = current.start;
      tokenEnd = current.end;
      activeMatches = EmoteMatch.findEmoteMatches(current.token, emoteList);
      highlighted = 0;
      renderSuggestions();
    }

    function applyCompletion(emote) {
      const text = serializeEditorText(editor);
      const completed = `${emote.name} `;
      rebuild(text.slice(0, tokenStart) + completed + text.slice(tokenEnd), tokenStart + completed.length);
      closeSuggestions();
      editor.focus();
    }

    function insertTextAtCaret(str) {
      const offset = getEditorCaretOffset(editor);
      if (offset === null) return;
      const text = serializeEditorText(editor);
      rebuild(text.slice(0, offset) + str + text.slice(offset), offset + str.length);
    }

    function handleContentChange() {
      const offset = getEditorCaretOffset(editor);
      rebuild(serializeEditorText(editor), offset);
      updateSuggestionsFromCaret();
    }

    // isComposing skips the rebuild mid-IME-composition (e.g. typing CJK text) - rebuilding out
    // from under an in-progress composition can corrupt it. The composing keystrokes are picked
    // up in one pass on compositionend instead.
    editor.addEventListener("input", (event) => {
      if (event.isComposing) return;
      handleContentChange();
    });
    editor.addEventListener("compositionend", handleContentChange);

    // Enter and paste are intercepted and routed through the same rebuild() pipeline rather than
    // left to the browser's own contenteditable behavior - see the file-level comment above for
    // why (that default behavior is exactly where cross-browser DOM-shape inconsistency lives).
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        insertTextAtCaret("\n");
        updateSuggestionsFromCaret();
        return;
      }

      // Only Tab accepts a suggestion (the currently arrow-highlighted one, default the first) -
      // when none are showing, Tab keeps its normal browser behavior (move focus onward).
      if (event.key === "Tab") {
        if (activeMatches.length === 0) return;
        event.preventDefault();
        applyCompletion(activeMatches[highlighted]);
        return;
      }

      if (activeMatches.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        highlighted = (highlighted + 1) % activeMatches.length;
        renderSuggestions();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        highlighted = (highlighted - 1 + activeMatches.length) % activeMatches.length;
        renderSuggestions();
      } else if (event.key === "Escape") {
        closeSuggestions();
      }
    });

    editor.addEventListener("paste", (event) => {
      event.preventDefault();
      const clipboard = event.clipboardData || window.clipboardData;
      const pasted = clipboard ? clipboard.getData("text/plain") : "";
      if (pasted) insertTextAtCaret(pasted);
      updateSuggestionsFromCaret();
    });

    // Deferred so a suggestion's mousedown (preventDefault()'d above, so it does NOT itself blur
    // the editor) still gets to run applyCompletion() before a blur from clicking elsewhere wipes
    // the dropdown out from under it.
    editor.addEventListener("blur", () => setTimeout(closeSuggestions, 0));

    // Last-resort safety net - every mutation path above already keeps textarea.value in sync,
    // but a submit-time resync costs nothing and guards against any path that doesn't.
    textarea.closest("form")?.addEventListener("submit", () => {
      textarea.value = serializeEditorText(editor);
    });

    textarea.hidden = true;
    wrap.insertBefore(editor, textarea);
  } catch (err) {
    // Fail-soft: a broken enhancement must never take away the ability to comment at all, so
    // undo the "already bound" flag and leave the plain (still fully functional) textarea alone.
    textarea.dataset.emoteBound = "0";
    console.error("[news-comments] emote editor enhancement failed:", err);
  }
}

function initEmoteAutocomplete(root, emoteList, emoteIndex) {
  if (typeof EmoteMatch === "undefined" || !emoteList || emoteList.length === 0) return;
  for (const textarea of root.querySelectorAll("[data-comment-input]")) {
    enhanceCommentTextarea(textarea, emoteList, emoteIndex);
  }
}

// Module-scope (not inside an IIFE) so the "load more comments" handler further down can bind
// newly-inserted reply-form textareas against the same parsed channel emote list, the same way
// it re-runs initReadMore() on new content instead of re-deriving anything.
let commentEmoteList = [];
let commentEmoteIndex = new Map();
{
  const dataEl = document.getElementById("comment-emote-data");
  if (dataEl) {
    commentEmoteList = JSON.parse(dataEl.textContent);
    if (typeof EmoteMatch !== "undefined") commentEmoteIndex = EmoteMatch.buildEmoteIndex(commentEmoteList);
  }
}
initEmoteAutocomplete(document, commentEmoteList, commentEmoteIndex);

const LOAD_MORE_PAGE_SIZE = 20; // routes/news.js's COMMENTS_PAGE_SIZE

// Both "load more" and "change sort" fetch routes/news.js's comments.json, which renders through
// the exact same commentThread.ejs partial the first page used - this pulls the <li>s back out of
// the wrapper <ul> the partial always emits, so a loaded-in-later/re-sorted thread is
// indistinguishable from one rendered on first paint either way.
function extractCommentLis(html) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  return [...wrapper.querySelectorAll(":scope > ul > li")];
}

// Every place that splices a freshly-fetched/rendered <li> into the live thread (load more,
// change sort, post a comment/reply) needs the exact same follow-up wiring: the read-more
// collapse, the emote-aware editor on any reply form it contains, AND (unlike those two, which
// were already delegated) bindCommentPostForm() on that reply form itself - a bare
// document-level click/submit delegation wouldn't have covered "submit", so newly-inserted reply
// forms need it bound explicitly, same as the other two.
function bindCommentSubtree(li) {
  initReadMore(li);
  initEmoteAutocomplete(li, commentEmoteList, commentEmoteIndex);
  for (const form of li.querySelectorAll("[data-comment-post-form]")) {
    bindCommentPostForm(form);
  }
}

// Load more comments: fetches the next page of ROOT threads and appends them to the existing
// #comment-thread-root <ul> - not a second <ul>, so the space-y-4 gap between threads stays
// consistent across pages. Extracted into its own bindable function (rather than a one-shot IIFE)
// because swapCommentSort() below needs to attach this same behavior to a freshly cloned button
// too, whenever switching sort reveals more pages than the button that was on-screen before.
function bindLoadMoreButton(button) {
  const list = document.getElementById("comment-thread-root");
  if (!list) return;

  const defaultText = button.textContent.trim();
  const loadingText = button.dataset.loadingText || defaultText;

  button.addEventListener("click", async () => {
    if (button.disabled) return;
    const { channel, post, sort } = button.dataset;
    const skip = parseInt(button.dataset.offset, 10) || 0;

    button.disabled = true;
    button.textContent = loadingText;
    try {
      const response = await fetch(`/${channel}/news/${post}/comments.json?skip=${skip}&sort=${encodeURIComponent(sort || "score")}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = await response.json();

      const insertedLis = extractCommentLis(data.html);
      for (const li of insertedLis) list.appendChild(li);
      for (const li of insertedLis) bindCommentSubtree(li);

      if (data.hasMore) {
        // Must match routes/news.js's COMMENTS_PAGE_SIZE - the server always returns up to that
        // many root threads per page regardless of how many actually rendered here, so the next
        // request's skip is this page's start plus the page size, not insertedLis.length.
        button.dataset.offset = String(skip + LOAD_MORE_PAGE_SIZE);
        button.disabled = false;
        button.textContent = defaultText;
      } else {
        button.remove();
      }
    } catch {
      // Leave the button clickable again so the visitor can just retry - same fail-soft
      // philosophy as the vote button above, no error banner for a low-stakes fetch failure.
      button.disabled = false;
      button.textContent = defaultText;
    }
  });
}

{
  const initialLoadMoreButton = document.querySelector("[data-comment-loadmore]");
  if (initialLoadMoreButton) bindLoadMoreButton(initialLoadMoreButton);
}

// Change comment sort ("Top"/"Newest"/"Oldest") in place: fetches the first page under the new
// sort (same comments.json endpoint "load more" uses, skip=0) and replaces #comment-thread-root's
// entire contents - no navigation, so scroll position never moves, unlike the plain
// <a href="?sort="> links this progressively enhances (those still work with JS disabled, just
// with the "lands you back at the top of the page" tradeoff that motivated this in the first
// place - see the memory note on avoiding scroll-jumping reloads where a JS alternative exists).
(() => {
  const group = document.querySelector("[data-comment-sort-group]");
  const list = document.getElementById("comment-thread-root");
  const loadMoreSlot = document.querySelector("[data-comment-loadmore-slot]");
  const loadMoreTemplate = document.getElementById("load-more-template");
  if (!group || !list) return;

  const { channel, post } = group.dataset;

  function setActiveSortStyles(sort) {
    group.dataset.activeSort = sort;
    for (const link of group.querySelectorAll("a[data-sort]")) {
      const active = link.dataset.sort === sort;
      link.classList.toggle("bg-neutral-800", active);
      link.classList.toggle("text-neutral-100", active);
      link.classList.toggle("text-neutral-500", !active);
      link.classList.toggle("hover:text-neutral-300", !active);
    }
  }

  group.addEventListener("click", async (event) => {
    const link = event.target.closest("a[data-sort]");
    if (!link || link.dataset.sort === group.dataset.activeSort) return;
    event.preventDefault();
    const sort = link.dataset.sort;

    try {
      const response = await fetch(`/${channel}/news/${post}/comments.json?skip=0&sort=${encodeURIComponent(sort)}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = await response.json();

      list.textContent = "";
      const insertedLis = extractCommentLis(data.html);
      for (const li of insertedLis) list.appendChild(li);
      for (const li of insertedLis) bindCommentSubtree(li);

      setActiveSortStyles(sort);
      // Keeps a refresh/shared link on the new sort without a real navigation.
      const url = new URL(window.location.href);
      url.searchParams.set("sort", sort);
      history.replaceState(null, "", url);

      // Rebuild the load-more slot for the new sort: the old button (if any) belonged to the
      // previous sort's pagination and must not keep working against it.
      if (loadMoreSlot) {
        loadMoreSlot.textContent = "";
        if (data.hasMore && loadMoreTemplate) {
          const clone = loadMoreTemplate.content.firstElementChild.cloneNode(true);
          clone.dataset.sort = sort;
          clone.dataset.offset = String(LOAD_MORE_PAGE_SIZE);
          loadMoreSlot.appendChild(clone);
          bindLoadMoreButton(clone);
        }
      }
    } catch {
      // Fail-soft: fall back to the real navigation the link already points to.
      window.location.href = link.href;
    }
  });
})();

// Posting a comment or reply: fetches instead of a full page POST-redirect-GET, splicing the
// newly rendered comment straight into the live thread - see routes/news.js's JSON branch, which
// renders the ONE new comment through the exact same commentThread.ejs partial the rest of the
// page uses, so the inserted <li> is indistinguishable from one present on first paint. Falls
// back to a real submit (routes/news.js's classic redirect branch) if the fetch itself fails.
let commentErrorMessages = {};
{
  const errorDataEl = document.getElementById("comment-error-messages");
  if (errorDataEl) {
    try {
      commentErrorMessages = JSON.parse(errorDataEl.textContent);
    } catch {
      commentErrorMessages = {};
    }
  }
}

function clearCommentForm(form) {
  const textarea = form.querySelector("[data-comment-input]");
  const editor = form.querySelector("[data-comment-editor]");
  if (textarea) textarea.value = "";
  if (editor) rebuildEditorFromText(editor, "", commentEmoteIndex);
}

function showCommentFormError(form, code) {
  const errorEl = form.querySelector("[data-comment-form-error]");
  if (!errorEl) return;
  errorEl.textContent = commentErrorMessages[code] || commentErrorMessages.invalid_body || "";
  errorEl.hidden = false;
}

function hideCommentFormError(form) {
  const errorEl = form.querySelector("[data-comment-form-error]");
  if (errorEl) errorEl.hidden = true;
}

function bindCommentPostForm(form) {
  form.addEventListener("submit", async (event) => {
    const list = document.getElementById("comment-thread-root");
    // No AJAX path without a root list to insert into - a post's very first-ever comment (see
    // views/newsPost.ejs, which only renders #comment-thread-root once at least one comment
    // already exists). A real submit is simplest and correct there; synthesizing the sort
    // control + list structure in JS just for this one rare case isn't worth the duplication.
    if (!list) return;

    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton.disabled) return;

    hideCommentFormError(form);
    submitButton.disabled = true;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: new URLSearchParams(new FormData(form)),
        headers: { Accept: "application/json" },
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        showCommentFormError(form, data.error || "invalid_body");
        return;
      }

      const [li] = extractCommentLis(data.html);
      if (!li) return;

      if (data.parentId) {
        const parentBody = document
          .getElementById(`comment-${data.parentId}`)
          ?.querySelector(":scope > div > [data-comment-body]");
        if (parentBody) {
          let childrenWrap = parentBody.querySelector(":scope > [data-comment-children]");
          let childrenUl;
          if (childrenWrap) {
            childrenUl = childrenWrap.querySelector(":scope > ul");
          } else {
            childrenWrap = document.createElement("div");
            childrenWrap.className = "mt-4 pl-4 border-l border-neutral-800";
            childrenWrap.setAttribute("data-comment-children", "");
            childrenUl = document.createElement("ul");
            childrenUl.className = "space-y-4";
            childrenWrap.appendChild(childrenUl);
            parentBody.appendChild(childrenWrap);
          }
          childrenUl.appendChild(li);
        }
        // The reply form collapses again, same as after any successful reply - the new comment
        // is now visible in the thread in its place.
        form.hidden = true;
      } else {
        // A brand-new top-level comment always surfaces at the top of the visible list for
        // immediate feedback, regardless of the active sort's exact tie-break rules - it settles
        // into its precise sorted position on the next full load/re-sort. Simpler, and in
        // practice exactly where a mod expects to see the thing they just posted.
        list.prepend(li);
      }

      bindCommentSubtree(li);
      clearCommentForm(form);

      for (const countEl of document.querySelectorAll("[data-comment-count]")) {
        countEl.textContent = String((parseInt(countEl.textContent, 10) || 0) + 1);
      }
    } catch {
      // Fail-soft: fall back to the plain submit the form would have done with JS disabled.
      form.submit();
      return;
    } finally {
      submitButton.disabled = false;
    }
  });
}

for (const form of document.querySelectorAll("[data-comment-post-form]")) {
  bindCommentPostForm(form);
}
