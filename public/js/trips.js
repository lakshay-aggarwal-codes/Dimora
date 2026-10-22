// Trip confirmation page (P09-T01): the Print button. Without JavaScript the
// browser's own print command still works; the button only saves a step.
(function () {
  "use strict";
  document.querySelectorAll("[data-print]").forEach(function (button) {
    button.addEventListener("click", function () {
      window.print();
    });
  });
})();
