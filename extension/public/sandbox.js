// Sandboxed renderer for model-written UI. Runs with a unique origin, no extension APIs,
// and a CSP that forbids all network access. It accepts exactly one document from its parent.
(function () {
  var rendered = false;
  window.addEventListener("message", function (e) {
    if (rendered || e.source !== window.parent || !e.data || e.data.type !== "tailor.render" || typeof e.data.doc !== "string") return;
    rendered = true;
    document.open();
    document.write(e.data.doc);
    document.close();
  });
  window.parent.postMessage({ type: "tailor.sandbox-ready" }, "*");
})();
