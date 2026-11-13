// Express handler for a page that moved to a new address for good.
//
// GET/HEAD get a 301. Anything else gets a 308: browsers turn a 301 on a POST into a GET and drop
// the body, so a form left open in a tab from before the move would "save" into a page view and
// lose the edit without a word. 308 is the same permanent move with the method and body kept.
// The query string is carried over, so ?saved=1 style flags and filters survive the hop.
function movedPermanently(target) {
  return (req, res) => {
    const base = typeof target === "function" ? target(req) : target;
    const queryAt = req.originalUrl.indexOf("?");
    const query = queryAt === -1 ? "" : req.originalUrl.slice(queryAt);
    const status = req.method === "GET" || req.method === "HEAD" ? 301 : 308;
    res.redirect(status, base + query);
  };
}

module.exports = { movedPermanently };
