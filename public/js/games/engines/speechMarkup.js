// The one piece of markup an expert speech is allowed to carry, and the tokenizer that turns it
// into DOM nodes.
//
// WHY THIS EXISTS AT ALL. The speeches on the Бюро амнистии's fourth sheet used to be one flat
// string set through textContent - safe, and unreadable at two thousand characters of pixel
// monospace. Structured fields (rule/headline/quotes/demand) carry most of the new formatting, but
// inside the speech itself there is still a difference between a sentence and the three words in it
// that the argument actually turns on, and only the speaker knows which three.
//
// WHY NOT MARKDOWN, AND WHY NOT innerHTML. Everything on this sheet is model output quoting an
// applicant's own chat lines back, rendered on a page a tier-2 moderator is logged into - see
// lib/unbanOpinionsValidation.js's header. Handing that text to a markdown library and the result to
// innerHTML would put attacker-influenced text one library bug away from script on that page. So the
// grammar is ONE marker, the parser is thirty lines, and the output is a token list the caller turns
// into text nodes: there is no code path here that can produce markup, only strings and a boolean.
//
// THE SPLIT IS THE SAME ONE THE BOT'S REPLY SANITIZER MAKES (../CLAUDE.md, "Rules are config too,
// guarantees are code"): the prompt ASKS for sparing emphasis, this file GUARANTEES that whatever
// comes back renders as text either way. A model that emits markdown headings, bullet lists,
// backticks or stray asterisks does not break the sheet - all of it lands as literal characters,
// which is exactly what an unparsed marker should look like.
//
// GRAMMAR
//   *выделение*   emphasis, rendered as <em>
//
// and nothing else. A `*` opens a span only when the character after it is not a space and there is
// a closing `*` later on the same line whose preceding character is not a space. Everything that
// does not match that - an unclosed marker, `2 * 2`, a line of `***`, a marker spanning a newline -
// stays literal. Nesting is not a thing: the first close ends the span.
//
// Same placement rule as replayCodec.js and the game engines beside it: this repo has no JS bundler,
// so lib/ never reaches the browser. A file both sides need lives here and exports itself as a
// CommonJS module OR a browser global depending on which environment loads it. The tests require it
// out of public/.
(function () {
  "use strict";

  var MARK = "*";

  // A marker only counts as one when it hugs the text it marks. This is what keeps arithmetic
  // ("2 * 2"), a line of asterisks used as a separator, and a trailing footnote star from opening a
  // span that then swallows the rest of the paragraph.
  function isSpace(ch) {
    return ch === undefined || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  /**
   * Splits a speech into `{text, em}` runs.
   *
   * The concatenation of every token's `text` is the original string minus only the markers that
   * were actually paired - so nothing is ever silently dropped, and a caller that ignores `em`
   * still renders the whole speech.
   *
   * @param {string} raw
   * @returns {{text: string, em: boolean}[]}
   */
  function tokenizeSpeech(raw) {
    var text = typeof raw === "string" ? raw : String(raw == null ? "" : raw);
    var tokens = [];
    var plain = "";
    var i = 0;

    function flush() {
      if (plain) {
        tokens.push({ text: plain, em: false });
        plain = "";
      }
    }

    while (i < text.length) {
      var ch = text.charAt(i);
      if (ch !== MARK || isSpace(text.charAt(i + 1))) {
        plain += ch;
        i += 1;
        continue;
      }

      // Look for the closing marker on THIS line. A span that ran across a paragraph break would
      // almost always be an unclosed marker rather than intent, and letting it run turns one stray
      // character into a whole italic sheet.
      // Starts at i + 2, never i + 1: a span has to contain at least one character, or a run of
      // asterisks would pair with itself and emit an empty <em> for each pair.
      var close = -1;
      for (var j = i + 2; j < text.length; j += 1) {
        var cj = text.charAt(j);
        if (cj === "\n") break;
        if (cj === MARK && !isSpace(text.charAt(j - 1))) {
          close = j;
          break;
        }
      }

      if (close === -1) {
        plain += ch;
        i += 1;
        continue;
      }

      flush();
      tokens.push({ text: text.slice(i + 1, close), em: true });
      i = close + 1;
    }

    flush();
    return tokens;
  }

  /**
   * Renders a speech into an existing element as text nodes and <em>s, replacing whatever it held.
   *
   * Browser-only half of the module - every string reaches the document through textContent or
   * createTextNode, never as markup. Kept here rather than in the page's own script so that the
   * grammar and the only renderer of it sit in one file and cannot drift apart.
   */
  function renderSpeechInto(node, raw) {
    node.textContent = "";
    var tokens = tokenizeSpeech(raw);
    for (var i = 0; i < tokens.length; i += 1) {
      var token = tokens[i];
      if (!token.em) {
        node.appendChild(document.createTextNode(token.text));
        continue;
      }
      var em = document.createElement("em");
      em.className = "ub-em";
      em.textContent = token.text;
      node.appendChild(em);
    }
    return node;
  }

  /**
   * Strips the markers without rendering - for anywhere the speech is shown as a plain string
   * (a title attribute, the transcript that goes back into the next turn's prompt).
   */
  function stripMarkup(raw) {
    return tokenizeSpeech(raw)
      .map(function (token) { return token.text; })
      .join("");
  }

  var api = { MARK: MARK, tokenizeSpeech: tokenizeSpeech, renderSpeechInto: renderSpeechInto, stripMarkup: stripMarkup };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    window.SpeechMarkup = api;
  }
})();
