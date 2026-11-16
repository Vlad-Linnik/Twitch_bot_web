// The cover's crop in the card form (views/mediaForm.ejs [data-poster-crop]). The frame has the
// tile's proportions and draws the picture exactly as the grid will (lib/mediaImage.js's
// posterCropStyle - the same arithmetic): drag to choose the part on show, wheel or slider to zoom,
// "reset" for the middle. A file chosen in the form is previewed in the same frame before saving.
//
// The result goes to the hidden posterCrop field as "x,y,w,h", fractions of the picture's width and
// height; the server re-derives h for the picture's real proportions (lib/posterCrop.js's normalizeCrop), so this file
// only has to be right, not trusted. An empty field means "the middle" (no crop stored).
//
// Plain script sharing one global scope with every other page script: everything stays inside the IIFE.
(() => {
  const root = document.querySelector("[data-poster-crop]");
  if (!root) return;

  const frame = root.querySelector("[data-crop-frame]");
  const img = root.querySelector("[data-crop-img]");
  const controls = root.querySelector("[data-crop-controls]");
  const zoomInput = root.querySelector("[data-crop-zoom]");
  const resetButton = root.querySelector("[data-crop-reset]");
  const input = root.querySelector("[data-crop-input]");
  const form = root.closest("form");
  const fileInput = form && form.querySelector("[data-crop-file]");
  const restore = form && form.querySelector("[data-crop-restore]");
  const aspect = Number(root.dataset.aspect) || 2 / 3;
  const MAX_ZOOM = Number(zoomInput.max) || 4;

  // The JS is here, so the field may be sent (see the template's comment).
  input.disabled = false;

  let ratio = 0; // picture width / height, once loaded
  let base = null; // the widest rectangle of the frame's proportions: {w, h}
  let crop = null; // {x, y, w, h}
  let objectUrl = null;

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const round4 = (n) => Math.round(n * 10000) / 10000;

  function middle() {
    return { x: (1 - base.w) / 2, y: (1 - base.h) / 2, w: base.w, h: base.h };
  }

  function draw() {
    if (!crop) return;
    Object.assign(img.style, {
      width: `${100 / crop.w}%`,
      height: `${100 / crop.h}%`,
      left: `${(-crop.x / crop.w) * 100}%`,
      top: `${(-crop.y / crop.h) * 100}%`,
      maxWidth: "none",
    });
    img.classList.remove("inset-0", "w-full", "h-full", "object-cover");
    zoomInput.value = String(round4(base.w / crop.w));
  }

  function write() {
    input.value = crop ? [crop.x, crop.y, crop.w, crop.h].map(round4).join(",") : "";
  }

  // A zoom of z keeps the rectangle's centre and is 1/z of the widest one.
  function setZoom(z) {
    const zoom = clamp(z, 1, MAX_ZOOM);
    const cx = crop.x + crop.w / 2;
    const cy = crop.y + crop.h / 2;
    const w = base.w / zoom;
    const h = base.h / zoom;
    crop = { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
    draw();
    write();
  }

  // The picture is in: work out its proportions and start from the stored crop (or the middle).
  function onLoad(storedCrop) {
    if (!img.naturalWidth || !img.naturalHeight) return;
    ratio = img.naturalWidth / img.naturalHeight;
    const w = Math.min(1, aspect / ratio);
    base = { w, h: (w * ratio) / aspect };
    if (storedCrop) {
      const cw = clamp(storedCrop.w, base.w / MAX_ZOOM, base.w);
      const ch = (cw * ratio) / aspect;
      crop = { x: clamp(storedCrop.x, 0, 1 - cw), y: clamp(storedCrop.y, 0, 1 - ch), w: cw, h: ch };
    } else {
      crop = middle();
    }
    frame.hidden = false;
    controls.hidden = false;
    draw();
  }

  function parseStored(value) {
    const parts = String(value || "").split(",").map(Number);
    return parts.length === 4 && parts.every(Number.isFinite) ? { x: parts[0], y: parts[1], w: parts[2], h: parts[3] } : null;
  }

  const stored = parseStored(input.value);
  if (img.getAttribute("src")) {
    if (img.complete) onLoad(stored);
    else img.addEventListener("load", () => onLoad(stored), { once: true });
  }

  // A new file: preview it in the frame, from the middle.
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      if (!file || !file.type.startsWith("image/")) return;
      objectUrl = URL.createObjectURL(file);
      crop = null;
      input.value = "";
      img.addEventListener("load", () => {
        onLoad(null);
        write();
      }, { once: true });
      img.src = objectUrl;
      if (restore) restore.checked = false;
      setEnabled(true);
    });
  }

  // "Bring back the automatic cover": the crop drawn here belongs to the picture being replaced.
  function setEnabled(on) {
    root.classList.toggle("opacity-40", !on);
    root.classList.toggle("pointer-events-none", !on);
    input.disabled = !on;
  }
  if (restore) restore.addEventListener("change", () => setEnabled(!restore.checked));

  // Drag to move. Pixels in the frame -> fractions of the picture: the frame's width is crop.w of it.
  let drag = null;
  frame.addEventListener("pointerdown", (event) => {
    if (!crop || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, start: { ...crop } };
    frame.setPointerCapture(event.pointerId);
    frame.classList.add("cursor-grabbing");
  });
  frame.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = frame.getBoundingClientRect();
    const dx = ((event.clientX - drag.x) / rect.width) * drag.start.w;
    const dy = ((event.clientY - drag.y) / rect.height) * drag.start.h;
    crop = { ...crop, x: clamp(drag.start.x - dx, 0, 1 - crop.w), y: clamp(drag.start.y - dy, 0, 1 - crop.h) };
    draw();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    frame.classList.remove("cursor-grabbing");
    write();
  };
  frame.addEventListener("pointerup", endDrag);
  frame.addEventListener("pointercancel", endDrag);
  frame.classList.add("cursor-grab");

  frame.addEventListener(
    "wheel",
    (event) => {
      if (!crop) return;
      event.preventDefault();
      setZoom(base.w / crop.w * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
    },
    { passive: false }
  );
  zoomInput.addEventListener("input", () => crop && setZoom(Number(zoomInput.value)));

  resetButton.addEventListener("click", () => {
    if (!base) return;
    crop = middle();
    draw();
    input.value = "";
  });
})();
