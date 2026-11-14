// The donation media setup page (views/donationMediaSetup.ejs): copy buttons for the OBS links and
// a confirmation before forms that break something already in use ([data-confirm] - replacing the
// links, disconnecting a platform). Without JS the links are selectable text and the forms submit.
document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const field = document.getElementById(button.dataset.copyTarget);
    if (!field) return;
    try {
      await navigator.clipboard.writeText(field.value);
    } catch (_) {
      field.select();
      document.execCommand("copy");
    }
    const label = button.textContent;
    button.textContent = button.dataset.copiedLabel || label;
    setTimeout(() => {
      button.textContent = label;
    }, 1500);
  });
});

document.querySelectorAll("form[data-confirm]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    if (!confirm(form.dataset.confirm)) event.preventDefault();
  });
});
