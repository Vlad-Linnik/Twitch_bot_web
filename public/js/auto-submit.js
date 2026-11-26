// Submits the form of any control marked data-auto-submit when its value changes. Exists because
// the CSP (app.js) gives script-src a nonce and helmet's default script-src-attr is 'none', so an
// inline onchange="this.form.submit()" never runs - the select just changes and nothing happens.
document.addEventListener("change", function (e) {
  var el = e.target;
  if (el && el.matches && el.matches("[data-auto-submit]") && el.form) el.form.submit();
});
