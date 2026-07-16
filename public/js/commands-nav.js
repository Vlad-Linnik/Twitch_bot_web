// Highlights the sidebar link matching whichever command-group section is
// currently in view, Twitch-API-reference-docs style. Pure progressive
// enhancement - the links are real in-page anchors and work without this.
const navLinks = document.querySelectorAll("[data-commands-nav-link]");

if (navLinks.length) {
  const linksByTarget = new Map();
  navLinks.forEach((link) => linksByTarget.set(link.dataset.target, link));

  const setActive = (id) => {
    navLinks.forEach((link) => {
      const isActive = link.dataset.target === id;
      link.classList.toggle("text-neutral-100", isActive);
      link.classList.toggle("border-purple-500", isActive);
      link.classList.toggle("text-neutral-500", !isActive);
      link.classList.toggle("border-transparent", !isActive);
    });
  };

  const observer = new IntersectionObserver(
    (entries) => {
      // Pick the entry closest to the top of the viewport among those currently
      // intersecting, rather than the last one IntersectionObserver happens to
      // report - multiple short sections can all be onscreen at once.
      const visible = entries.filter((e) => e.isIntersecting);
      if (!visible.length) return;
      visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      setActive(visible[0].target.id);
    },
    { rootMargin: "-5rem 0px -70% 0px", threshold: 0 }
  );

  document.querySelectorAll("[data-command-group]").forEach((section) => observer.observe(section));
}
