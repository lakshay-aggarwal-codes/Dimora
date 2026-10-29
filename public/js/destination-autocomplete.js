// Destination suggestions for the search boxes (P05-T06). Without this file the
// boxes are ordinary text fields. With it, typing two or more letters asks
// /api/destinations (our own server, no third party) and shows the places that
// really have stays.
//
// Accessible combobox (ARIA 1.2 "list" autocomplete): the input keeps focus,
// Up/Down move through the options (aria-activedescendant), Enter picks the
// highlighted one (with none highlighted, Enter submits the form as it always
// did), Escape closes, Tab leaves. The count of suggestions is announced.
(function () {
  "use strict";

  var DELAY_MS = 250; // wait for a pause in typing
  var MIN_CHARS = 2;
  var uid = 0;

  function enhance(input) {
    if (!window.fetch || input.getAttribute("data-ac-ready")) return;
    input.setAttribute("data-ac-ready", "1");
    uid += 1;
    var listId = "dest-ac-list-" + uid;

    var list = document.createElement("ul");
    list.id = listId;
    list.className = "dest-ac-list";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    var label = input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
    if (label && label.textContent) list.setAttribute("aria-label", label.textContent.trim() + " suggestions");
    else list.setAttribute("aria-label", "Destination suggestions");
    document.body.appendChild(list);

    var status = document.createElement("div");
    status.className = "visually-hidden";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    document.body.appendChild(status);

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", listId);
    input.setAttribute("autocomplete", "off");

    var timer = null;
    var controller = null;
    var items = [];
    var active = -1;
    var latest = "";

    function place() {
      var box = input.getBoundingClientRect();
      list.style.left = box.left + window.pageXOffset + "px";
      list.style.top = box.bottom + window.pageYOffset + 2 + "px";
      list.style.minWidth = Math.max(box.width, 220) + "px";
    }

    function close() {
      list.hidden = true;
      list.textContent = "";
      items = [];
      active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }

    function highlight(index) {
      var options = list.children;
      for (var i = 0; i < options.length; i += 1) {
        options[i].setAttribute("aria-selected", i === index ? "true" : "false");
        options[i].classList.toggle("is-active", i === index);
      }
      active = index;
      if (index >= 0) {
        input.setAttribute("aria-activedescendant", options[index].id);
        if (options[index].scrollIntoView) options[index].scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    function choose(index) {
      if (index < 0 || index >= items.length) return;
      input.value = items[index].dest;
      close();
      input.focus();
    }

    function show(found) {
      list.textContent = "";
      items = found;
      found.forEach(function (item, i) {
        var li = document.createElement("li");
        li.id = listId + "-" + i;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        li.className = "dest-ac-option";
        var name = document.createElement("span");
        name.textContent = item.label; // text, never HTML
        var count = document.createElement("span");
        count.className = "dest-ac-count";
        count.textContent = item.count + (item.count === 1 ? " stay" : " stays");
        li.appendChild(name);
        li.appendChild(count);
        // mousedown, not click: it fires before the input loses focus.
        li.addEventListener("mousedown", function (event) {
          event.preventDefault();
          choose(i);
        });
        list.appendChild(li);
      });
      if (found.length === 0) {
        close();
        status.textContent = "";
        return;
      }
      place();
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      highlight(-1);
      status.textContent = found.length + (found.length === 1 ? " suggestion" : " suggestions") + " available. Use the up and down arrow keys.";
    }

    function ask() {
      var text = input.value.trim();
      latest = text;
      if (text.replace(/[\s,]/g, "").length < MIN_CHARS) {
        close();
        status.textContent = "";
        return;
      }
      if (controller) controller.abort();
      controller = window.AbortController ? new AbortController() : null;
      fetch("/api/destinations?q=" + encodeURIComponent(text), {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller ? controller.signal : undefined,
      })
        .then(function (res) {
          return res.ok ? res.json() : { suggestions: [] };
        })
        .then(function (body) {
          if (text !== latest) return; // the box changed while we waited
          if (document.activeElement !== input) return close();
          show(Array.isArray(body.suggestions) ? body.suggestions : []);
        })
        .catch(function () {
          /* aborted, offline or failed: the box is an ordinary field */
        });
    }

    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(ask, DELAY_MS);
    });

    input.addEventListener("keydown", function (event) {
      var open = !list.hidden && items.length > 0;
      if (event.key === "ArrowDown" && open) {
        event.preventDefault();
        highlight(active + 1 >= items.length ? 0 : active + 1);
      } else if (event.key === "ArrowUp" && open) {
        event.preventDefault();
        highlight(active <= 0 ? items.length - 1 : active - 1);
      } else if (event.key === "Enter" && open && active >= 0) {
        event.preventDefault(); // pick the suggestion instead of submitting
        choose(active);
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        close();
      }
    });

    input.addEventListener("blur", function () {
      clearTimeout(timer);
      if (controller) controller.abort();
      close();
    });
    window.addEventListener("resize", function () {
      if (!list.hidden) place();
    });
  }

  function init() {
    var inputs = document.querySelectorAll("input[data-destination-autocomplete]");
    for (var i = 0; i < inputs.length; i += 1) enhance(inputs[i]);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
