// The tone list on /admin/ai/channels/<login>. Choosing a saved tone takes effect at once, through
// its own request; adding, editing and deleting are part of the form and wait for its Save button.
// Without JS the cards are a plain form with every text open and one blank card to fill.
(() => {
  const root = document.querySelector("[data-tones]");
  if (!root) return;

  const form = root.closest("form");
  const list = root.querySelector("[data-tone-list]");
  const addButton = root.querySelector("[data-tone-add]");
  const status = root.querySelector("[data-tone-status]");
  const template = root.querySelector("template[data-tone-template]");
  const max = Number(root.dataset.max);
  let added = 0;
  // The choice the server last confirmed; a failed switch returns to it.
  let confirmed = root.querySelector('input[name="aiToneActive"]:checked')?.value ?? "";

  const radios = () => [...root.querySelectorAll('input[name="aiToneActive"]')];
  const cards = () => [...list.querySelectorAll("[data-tone]")];

  const say = (text, bad) => {
    status.textContent = text || "";
    status.classList.toggle("text-red-400", Boolean(bad));
    status.classList.toggle("text-neutral-500", !bad);
  };

  const setOpen = (card, open) => {
    card.querySelector("[data-tone-body]").hidden = !open;
    const toggle = card.querySelector("[data-tone-toggle]");
    toggle.textContent = open ? toggle.dataset.hide : toggle.dataset.show;
    toggle.setAttribute("aria-expanded", String(open));
  };

  const refreshAdd = () => {
    addButton.hidden = cards().length >= max;
  };

  const prepare = (card, open) => {
    card.querySelector("[data-tone-toggle]").hidden = false;
    card.querySelector("[data-tone-delete]").hidden = false;
    setOpen(card, open);
  };

  cards().forEach((card) => prepare(card, card.querySelector(".tone-radio").checked));
  refreshAdd();

  let sent = 0;
  const choose = async (toneId) => {
    const turn = ++sent;
    say(root.dataset.textSwitching);
    try {
      const response = await fetch(root.dataset.switchUrl, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new URLSearchParams({ _csrf: form.elements._csrf.value, toneId }),
      });
      if (!response.ok) throw new Error(String(response.status));
      confirmed = toneId;
      if (turn === sent) say(root.dataset.textSwitched);
    } catch {
      if (turn !== sent) return;
      const back = radios().find((r) => r.value === confirmed);
      if (back) back.checked = true;
      say(root.dataset.textFailed, true);
    }
  };

  root.addEventListener("change", (event) => {
    if (event.target.name !== "aiToneActive") return;
    const id = event.target.value;
    const card = event.target.closest("[data-tone]");
    if (card) setOpen(card, true);
    // A card that is not stored yet has nothing to switch to on the server.
    if (id.startsWith("new-")) {
      sent++;
      say(root.dataset.textUnsaved);
    } else choose(id);
  });

  root.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-tone-toggle]");
    if (toggle) {
      const card = toggle.closest("[data-tone]");
      setOpen(card, card.querySelector("[data-tone-body]").hidden);
      return;
    }
    const del = event.target.closest("[data-tone-delete]");
    if (del) {
      const card = del.closest("[data-tone]");
      const filled = card.querySelector('[name="aiToneText"]').value.trim();
      if (filled && !confirm(del.dataset.confirmText)) return;
      const wasOn = card.querySelector(".tone-radio").checked;
      card.remove();
      if (wasOn) root.querySelector('input[name="aiToneActive"][value=""]').checked = true;
      say(root.dataset.textDeleted);
      refreshAdd();
    }
  });

  addButton.addEventListener("click", () => {
    const card = template.content.firstElementChild.cloneNode(true);
    const id = `new-${++added}`;
    card.querySelector("[data-tone-id]").value = id;
    card.querySelector(".tone-radio").value = id;
    list.append(card);
    prepare(card, true);
    refreshAdd();
    card.querySelector('[name="aiToneName"]').focus();
  });
  addButton.parentElement.hidden = false;
})();
