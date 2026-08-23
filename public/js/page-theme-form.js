// Keeps the palette picker in step with the skin picker on /admin/page-themes/:userId.
//
// The two lists are not interchangeable: every palette preset belongs to exactly one skin
// (lib/pageThemeValidation.js's ACCENT_PRESETS), so a form still offering the gilded hall's
// palettes after the rose room has been chosen offers four values the server will reject back
// to a default. The template renders every skin's group and disables the ones that do not
// apply; this only moves which group is live.
//
// Progressive enhancement, not a requirement: without it the groups stay as the server drew
// them and a save under a freshly-switched skin falls back to that skin's first palette.
(function () {
  const skinSelect = document.getElementById("theme-skin");
  const presetSelect = document.getElementById("theme-accent-preset");
  const customInput = document.querySelector('input[name="accent.custom"]');
  const presetMode = document.querySelector('input[name="accent.mode"][value="preset"]');
  if (!skinSelect || !presetSelect) return;

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

  function syncPresets() {
    const skin = skinSelect.value;
    let firstOfSkin = null;
    const groups = presetSelect.querySelectorAll("optgroup");
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const belongs = group.getAttribute("data-theme") === skin;
      // `hidden` alone is not enough: browsers disagree about whether a hidden option can still
      // be selected with the keyboard, while a disabled group is unselectable everywhere.
      group.disabled = !belongs;
      group.hidden = !belongs;
      if (belongs && !firstOfSkin) firstOfSkin = group.querySelector("option");
    }

    // After a swap the still-selected preset belongs to the other room, and a disabled option
    // submits nothing at all - so move to the new skin's first palette rather than leaving the
    // field in a state that only looks chosen.
    const selected = presetSelect.options[presetSelect.selectedIndex];
    const selectedGroup = selected && selected.parentElement;
    const stillValid = selectedGroup && selectedGroup.getAttribute("data-theme") === skin;
    if (!stillValid && firstOfSkin) firstOfSkin.selected = true;
  }

  // Only while the form is on "accent from palette": once a custom colour has been chosen, the
  // well holds the user's own value and nothing here may overwrite it.
  function syncCustomWell() {
    if (!customInput || !presetMode || !presetMode.checked) return;
    const accent = paletteAccent(skinSelect.value, presetSelect.value);
    if (/^#[0-9a-f]{6}$/i.test(accent)) customInput.value = accent.toLowerCase();
  }

  skinSelect.addEventListener("change", function () {
    syncPresets();
    syncCustomWell();
  });
  presetSelect.addEventListener("change", syncCustomWell);
  syncPresets();
  syncCustomWell();
})();
