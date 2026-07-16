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
