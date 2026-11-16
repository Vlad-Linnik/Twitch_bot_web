// The viewer's own notifications (db/notificationsRepo.js), login-required, not channel-scoped:
//   GET  /notifications                 the full list - also the bell's no-JS destination
//   GET  /notifications.json            unread count + the latest few, for public/js/notifications.js
//   POST /notifications/:id/open        mark one read, then go to it (JSON {link} or a redirect)
//   POST /notifications/read-all        mark all read
//
// Every query is keyed on req.user.userId - a notification id from the URL is only ever looked up
// together with the viewer's id (lib/notifications.js's markReadFilter).
//
// Mounted among the static pages: "/notifications" must not be read as a channel's name.
const express = require("express");
const notificationsRepo = require("../db/notificationsRepo");
const requireLogin = require("../middleware/requireLogin");
const { verifyToken } = require("../middleware/csrf");
const { sanitizeReturnTo } = require("../lib/returnTo");
const { DROPDOWN_LIMIT, PAGE_LIMIT, badgeText } = require("../lib/notifications");

const router = express.Router();

const wantsJson = (req) => (req.get("accept") || "").includes("application/json");

// One notice as both the page and the dropdown show it. Every string is built here, with the
// viewer's locale, and the client puts it into text nodes only: the excerpt, the title and the
// replier's display name are all somebody else's input.
function shape(n, t) {
  const sectionKey = `notifications.sections.${n.section}`;
  const sectionLabel = t(sectionKey);
  return {
    id: String(n._id),
    read: Boolean(n.read),
    headline: t("notifications.replyHeadline", { name: n.actorDisplayName || n.actorLogin }),
    where: t("notifications.where", {
      section: sectionLabel === sectionKey ? n.section : sectionLabel,
      title: n.itemTitle || "—",
      channel: n.channelLogin,
    }),
    excerpt: n.excerpt || "",
    createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : String(n.createdAt),
    href: n.link,
  };
}

router.get("/notifications.json", requireLogin, async (req, res, next) => {
  try {
    const [unread, items] = await Promise.all([
      notificationsRepo.countUnread(req.user.userId),
      notificationsRepo.listForUser(req.user.userId, { limit: DROPDOWN_LIMIT }),
    ]);
    const t = res.locals.t;
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      unread,
      badge: badgeText(unread),
      items: items.map((n) => shape(n, t)),
      labels: {
        title: t("notifications.title"),
        empty: t("notifications.empty"),
        markAllRead: t("notifications.markAllRead"),
        viewAll: t("notifications.viewAll"),
        unreadMark: t("notifications.unreadMark"),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/notifications", requireLogin, async (req, res, next) => {
  try {
    const items = await notificationsRepo.listForUser(req.user.userId, { limit: PAGE_LIMIT });
    const t = res.locals.t;
    res.render("notifications", { notifications: items.map((n) => shape(n, t)) });
  } catch (err) {
    next(err);
  }
});

router.post("/notifications/read-all", requireLogin, verifyToken, async (req, res, next) => {
  try {
    await notificationsRepo.markAllRead(req.user.userId);
    if (wantsJson(req)) return res.json({ ok: true, unread: 0, badge: "" });
    res.redirect("/notifications");
  } catch (err) {
    next(err);
  }
});

router.post("/notifications/:id/open", requireLogin, verifyToken, async (req, res, next) => {
  try {
    const notice = await notificationsRepo.markRead(req.user.userId, req.params.id);
    // The link is ours (lib/notifications.js's replyLink), but it is still a redirect target.
    const link = notice ? sanitizeReturnTo(notice.link) : null;
    if (wantsJson(req)) {
      if (!link) return res.status(404).json({ ok: false, error: "not_found" });
      return res.json({ ok: true, link });
    }
    res.redirect(link || "/notifications");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
