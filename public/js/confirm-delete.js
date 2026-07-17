// Same [data-confirm-delete] convention as public/js/word-list-search.js - kept as its own small
// file here since this page has no other JS and doesn't need that script's search filtering.
document.querySelectorAll("[data-confirm-delete]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    if (!confirm(form.dataset.confirmDelete || "Delete this entry?")) {
      event.preventDefault();
    }
  });
});
