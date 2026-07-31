// Pure/testable helpers behind the news feature (routes/admin.js's create/edit handlers) -
// same "extract for npm test" convention as sanitizeWord/parseSubmittedConfig in
// lib/settingsValidation.js. The admin's own session is the only trust boundary for news
// content, but every post still gets rendered to every visitor's browser, so bodyRaw is
// sanitized here before it's ever stored - not just at render time.
const { marked } = require("marked");
const sanitizeHtml = require("sanitize-html");

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 20000;
const BODY_FORMATS = ["markdown", "html"];

const SANITIZE_OPTIONS = {
  allowedTags: [
    "p", "br", "strong", "em", "b", "i", "u", "s", "h1", "h2", "h3", "h4",
    "ul", "ol", "li", "a", "blockquote", "code", "pre", "hr", "span",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    span: ["style"],
  },
  // Only the color/font-weight/font-style a toolbar-driven editor would ever emit - no
  // position/url()/expression() surface.
  allowedStyles: {
    span: {
      color: [/^#[0-9a-fA-F]{3,6}$/, /^rgb\(/, /^[a-zA-Z]+$/],
      "font-weight": [/^bold$/],
      "font-style": [/^italic$/],
    },
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
  },
};

function sanitizeTitle(value) {
  return (value || "").toString().trim().slice(0, MAX_TITLE_LENGTH);
}

function isValidBodyFormat(value) {
  return BODY_FORMATS.includes(value);
}

function sanitizeBodyRaw(value) {
  return (value || "").toString().trim().slice(0, MAX_BODY_LENGTH);
}

// Markdown -> HTML -> sanitize, or straight sanitize for hand-authored HTML. Always run
// through sanitize-html regardless of format - marked's own output is safe, but this is the
// one place both paths converge, so it's also the one place that has to hold the line.
function renderBody(bodyFormat, bodyRaw) {
  const html = bodyFormat === "markdown" ? marked.parse(bodyRaw || "") : bodyRaw || "";
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

module.exports = {
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
  BODY_FORMATS,
  sanitizeTitle,
  isValidBodyFormat,
  sanitizeBodyRaw,
  renderBody,
};
