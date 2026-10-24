// The heart on listing cards and the detail page (P10-T01). Without this file
// the heart is a normal form post (the page reloads). With it, the click is
// sent in the background and only the heart changes.
(function () {
  "use strict";

  function paint(button, saved) {
    var title = button.getAttribute("data-title") || "this stay";
    var form = button.closest("form");
    button.setAttribute("aria-pressed", saved ? "true" : "false");
    button.setAttribute(
      "aria-label",
      (saved ? "Remove " : "Save ") + title + (saved ? " from" : " to") + " your saved stays",
    );
    button.classList.toggle("is-saved", saved);
    var icon = button.querySelector("i");
    if (icon) {
      icon.classList.toggle("fa-solid", saved);
      icon.classList.toggle("fa-regular", !saved);
    }
    // The next click asks for the opposite of what is shown now.
    form.elements.saved.value = saved ? "false" : "true";
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.hasAttribute || !form.hasAttribute("data-save-form")) return;
    if (!window.fetch) return; // old browser: the normal form post still works
    event.preventDefault();

    var button = form.querySelector(".save-button");
    if (button.disabled) return;
    var wanted = form.elements.saved.value === "true";
    button.disabled = true;

    fetch(form.action, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-Token": form.elements._csrf ? form.elements._csrf.value : "",
      },
      body: new URLSearchParams({ saved: String(wanted) }).toString(),
    })
      .then(function (response) {
        var type = response.headers.get("content-type") || "";
        if (type.indexOf("application/json") === -1) {
          // Not JSON: most likely sent to the login page. Do it the plain way.
          form.submit();
          return null;
        }
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result) return;
        if (result.ok) {
          paint(button, result.body.saved === true);
        } else {
          window.alert((result.body && (result.body.error || result.body.message)) || "That did not work. Try again.");
        }
      })
      .catch(function () {
        form.submit();
      })
      .then(function () {
        button.disabled = false;
      });
  });
})();
