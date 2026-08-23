// Keeps the skin-scoped pickers in step with the skin picker on /admin/page-themes/:userId.
//
// Two selects are scoped to a skin - the palette and the shipped wallpaper - and neither list is
// interchangeable: every preset belongs to exactly one skin (lib/pageThemeValidation.js's
// ACCENT_PRESETS and BACKDROP_PRESETS), so a form still offering the gilded hall's after the rose
// bower has been chosen offers values the server will reject back to a default. The template
// renders every skin's group and disables the ones that do not apply; this only moves which group
// is live. Any select marked [data-skin-scoped] joins in, so a third such list needs no change
// here.
//
// Progressive enhancement, not a requirement: without it the groups stay as the server drew
// them and a save under a freshly-switched skin falls back to that skin's first palette.
(function () {
  const skinSelect = document.getElementById("theme-skin");
  const scoped = document.querySelectorAll("select[data-skin-scoped]");
  const presetSelect = document.getElementById("theme-accent-preset");
  const customInput = document.querySelector('input[name="accent.custom"]');
  const presetMode = document.querySelector('input[name="accent.mode"][value="preset"]');
  if (!skinSelect || !scoped.length) return;

  // The colour well starts on the CURRENT palette's accent instead of a hardcoded one. The
  // server deliberately does not know any hex values (lib/pageThemeValidation.js's header), so
  // the value is read back out of the stylesheet: the palette classes go onto <body> exactly
  // long enough for one getComputedStyle. Nothing paints in between - the browser renders
  // between tasks, not inside one - so the admin page never flashes the skin it is describing.
  function paletteAccent(skin, preset) {
    const body = document.body;
    const added = ["theme-hall", "theme-" + skin, "palette-" + preset].filter(function (name) {
      return !body.classList.contains(name);
    });
    body.classList.add.apply(body.classList, added);
    const value = getComputedStyle(body).getPropertyValue("--throne-accent").trim();
    body.classList.remove.apply(body.classList, added);
    return value;
  }

  function syncOne(select, skin) {
    let firstOfSkin = null;
    const groups = select.querySelectorAll("optgroup");
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const belongs = group.getAttribute("data-theme") === skin;
      // `hidden` alone is not enough: browsers disagree about whether a hidden option can still
      // be selected with the keyboard, while a disabled group is unselectable everywhere.
      group.disabled = !belongs;
      group.hidden = !belongs;
      if (belongs && !firstOfSkin) firstOfSkin = group.querySelector("option");
    }

    // After a swap the still-selected value belongs to the other room, and a disabled option
    // submits nothing at all - so move to the new skin's first entry rather than leaving the
    // field in a state that only looks chosen.
    const selected = select.options[select.selectedIndex];
    const selectedGroup = selected && selected.parentElement;
    const stillValid = selectedGroup && selectedGroup.getAttribute("data-theme") === skin;
    if (!stillValid && firstOfSkin) firstOfSkin.selected = true;
  }

  function syncPresets() {
    for (let i = 0; i < scoped.length; i++) syncOne(scoped[i], skinSelect.value);
  }

  // Only while the form is on "accent from palette": once a custom colour has been chosen, the
  // well holds the user's own value and nothing here may overwrite it.
  function syncCustomWell() {
    if (!customInput || !presetSelect || !presetMode || !presetMode.checked) return;
    const accent = paletteAccent(skinSelect.value, presetSelect.value);
    if (/^#[0-9a-f]{6}$/i.test(accent)) customInput.value = accent.toLowerCase();
  }

  skinSelect.addEventListener("change", function () {
    syncPresets();
    syncCustomWell();
  });
  if (presetSelect) presetSelect.addEventListener("change", syncCustomWell);
  syncPresets();
  syncCustomWell();
})();
