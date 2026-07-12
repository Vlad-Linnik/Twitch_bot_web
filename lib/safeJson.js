// Serialize a value for embedding inside a <script> tag in an EJS view.
//
// This is NOT the same job as JSON.stringify(). The dashboards inline server-fetched data so the
// browser does not have to re-request what the server already paid to compute - but that payload
// is built from CHAT-DERIVED strings: words from the cloud, nickname history, raw message bodies.
// Twitch chat is attacker-controlled input, so two things have to be neutralised:
//
//   "</script>"     - closes the tag early; everything after it is then parsed as HTML, so a chat
//                     message like `</script><img src=x onerror=alert(1)>` would execute.
//   U+2028 / U+2029 - legal inside a JSON string, but they are LINE TERMINATORS in JavaScript
//                     source, so they can break any script that inlines the JSON.
//
// Escaping them as \uXXXX keeps the output valid JSON - JSON.parse() reads the escapes back as
// the original characters - while making it inert as markup.
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

module.exports = safeJson;
