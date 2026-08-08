// Bulk-select support for /admin/settings-log. Each row checkbox is wired to the external
// #settings-log-bulk-form via the HTML `form=` attribute rather than DOM nesting, since a
// checkbox can't sit inside two <form>s at once (the row already lives inside a per-row
// single-delete <form>). Confirms with the actual selected count before submitting, since
// confirm-delete.js's [data-confirm-delete] only handles a fixed message.
(function () {
  const selectAll = document.getElementById("select-all-checkbox");
  const deleteBtn = document.getElementById("delete-selected-btn");
  const bulkForm = document.getElementById("settings-log-bulk-form");
  if (!deleteBtn || !bulkForm) return;

  const rowCheckboxes = () => Array.from(document.querySelectorAll(".log-row-checkbox"));

  function refresh() {
    const count = rowCheckboxes().filter((cb) => cb.checked).length;
    deleteBtn.textContent = deleteBtn.dataset.labelTemplate.replace("{{count}}", String(count));
    deleteBtn.disabled = count === 0;
    if (selectAll) {
      const all = rowCheckboxes();
      selectAll.checked = all.length > 0 && all.every((cb) => cb.checked);
    }
  }

  rowCheckboxes().forEach((cb) => cb.addEventListener("change", refresh));

  if (selectAll) {
    selectAll.addEventListener("change", () => {
      rowCheckboxes().forEach((cb) => {
        cb.checked = selectAll.checked;
      });
      refresh();
    });
  }

  bulkForm.addEventListener("submit", (event) => {
    const count = rowCheckboxes().filter((cb) => cb.checked).length;
    if (count === 0 || !confirm(deleteBtn.dataset.confirmTemplate.replace("{{count}}", String(count)))) {
      event.preventDefault();
    }
  });

  refresh();
})();
