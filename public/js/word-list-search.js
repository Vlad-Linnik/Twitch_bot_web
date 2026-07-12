const searchInput = document.getElementById("word-search");
const addForm = document.getElementById("word-add-form");
const addInput = document.getElementById("word-add-input");

if (searchInput) {
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    let visibleCount = 0;
    let exactMatch = false;

    document.querySelectorAll("[data-word-row]").forEach((row) => {
      const matches = !query || row.dataset.searchText.includes(query);
      row.classList.toggle("hidden", !matches);
      if (matches) visibleCount += 1;
      if (row.dataset.searchText === query) exactMatch = true;
    });

    if (addForm) {
      const showAdd = query && !exactMatch;
      addForm.classList.toggle("hidden", !showAdd);
      if (showAdd && addInput) addInput.value = searchInput.value.trim();
    }
  });
}

document.querySelectorAll("[data-confirm-delete]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    if (!confirm(form.dataset.confirmDelete || "Delete this entry?")) {
      event.preventDefault();
    }
  });
});
