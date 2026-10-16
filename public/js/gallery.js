// Listing photo viewer (P04-T03). Progressive enhancement of
// views/partials/gallery.ejs: every photo is a link to the large picture, and
// this script opens those links in a <dialog> instead. Everything it shows
// comes from the links' attributes (href, data-alt, data-caption) and is set as
// text or as an attribute, never as HTML.
//
// Keyboard: Enter on a photo opens the viewer; Left/Right arrows (or the
// Previous/Next buttons) move; Escape or Close leaves; focus goes back to the
// photo that was opened. A browser without <dialog> keeps the plain links.
(function () {
  const root = document.querySelector("[data-gallery]");
  if (!root) return;
  const dialog = root.querySelector("dialog[data-lightbox]");
  if (!dialog || typeof dialog.showModal !== "function") return;

  const links = Array.from(root.querySelectorAll("[data-gallery-item]"));
  if (links.length === 0) return;

  const img = dialog.querySelector("[data-lightbox-img]");
  const caption = dialog.querySelector("[data-lightbox-caption]");
  const count = dialog.querySelector("[data-lightbox-count]");
  const closeButton = dialog.querySelector("[data-lightbox-close]");
  const prevButton = dialog.querySelector("[data-lightbox-prev]");
  const nextButton = dialog.querySelector("[data-lightbox-next]");

  let current = 0;
  let opener = null;

  // Next index, wrapping around at either end.
  function wrap(index, delta, length) {
    return (((index + delta) % length) + length) % length;
  }

  function show(index) {
    current = wrap(index, 0, links.length);
    const link = links[current];
    img.setAttribute("src", link.getAttribute("href"));
    img.setAttribute("alt", link.dataset.alt || "");
    caption.textContent = link.dataset.caption || "";
    count.textContent = "Photo " + (current + 1) + " of " + links.length;
  }

  function open(index, from) {
    opener = from || null;
    show(index);
    dialog.showModal();
  }

  links.forEach(function (link, index) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      open(index, link);
    });
  });

  if (prevButton) {
    prevButton.addEventListener("click", function () {
      show(wrap(current, -1, links.length));
    });
  }
  if (nextButton) {
    nextButton.addEventListener("click", function () {
      show(wrap(current, 1, links.length));
    });
  }
  if (closeButton) {
    closeButton.addEventListener("click", function () {
      dialog.close();
    });
  }

  dialog.addEventListener("keydown", function (event) {
    if (links.length < 2) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      show(wrap(current, -1, links.length));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      show(wrap(current, 1, links.length));
    }
  });

  // A click on the dark area around the picture closes it.
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) dialog.close();
  });

  // Escape, Close and the backdrop all end here: put focus back.
  dialog.addEventListener("close", function () {
    img.setAttribute("src", "");
    if (opener && typeof opener.focus === "function") opener.focus();
    opener = null;
  });
})();
