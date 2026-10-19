// Loading state for the listings page (P05-T04). The search form, the filter
// panel, the category strip, the filter chips, the sort links and the page
// links are all plain GET forms and links, so everything works without this
// script. With it, the results area is marked busy and a short message is
// announced while the next page loads. Nothing here changes what is sent.
(function () {
  "use strict";

  var results = document.getElementById("results");
  var status = document.getElementById("search-status");
  if (!results || !status) return;

  function busy() {
    results.setAttribute("aria-busy", "true");
    results.classList.add("is-loading");
    status.textContent = "Updating results\u2026";
    status.hidden = false;
  }

  function idle() {
    results.removeAttribute("aria-busy");
    results.classList.remove("is-loading");
    status.textContent = "";
    status.hidden = true;
  }

  Array.prototype.forEach.call(
    document.querySelectorAll('form[role="search"], form[data-loading-form]'),
    function (form) {
      form.addEventListener("submit", function () {
        busy();
      });
    },
  );

  // Links that load another version of this page. A click that opens a new tab
  // or window (modifier keys, middle button) is left alone.
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var target = event.target;
    var link = target && target.closest ? target.closest("a[href]") : null;
    if (!link || link.target === "_blank") return;
    if (!link.closest(".filter-nav, .filter-chips, .pagination-nav, .filter-panel-actions")) return;
    busy();
  });

  // Coming back with the browser's back button can restore this page as it was
  // while busy.
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) idle();
  });
})();
