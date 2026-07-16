// The channel selector auto-submits its form on change. This can't be an inline
// onchange= attribute on the <select>: helmet's CSP sends script-src-attr 'none',
// so browsers refuse to run inline handlers. The <noscript> Apply button in
// commands.ejs stays as the no-JS fallback.
const channelSelect = document.getElementById("commands-channel");

if (channelSelect) {
  channelSelect.addEventListener("change", () => channelSelect.form.submit());
}

const searchInput = document.getElementById("commands-search");

if (searchInput) {
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();

    document.querySelectorAll("[data-command-section]").forEach((section) => {
      let sectionVisibleCount = 0;

      section.querySelectorAll("[data-command-group]").forEach((group) => {
        let visibleCount = 0;

        group.querySelectorAll("[data-command-row]").forEach((row) => {
          const matches = !query || row.dataset.searchText.includes(query);
          row.classList.toggle("hidden", !matches);
          if (matches) visibleCount += 1;
        });

        group.classList.toggle("hidden", visibleCount === 0);
        sectionVisibleCount += visibleCount;
      });

      section.classList.toggle("hidden", sectionVisibleCount === 0);
    });
  });
}
