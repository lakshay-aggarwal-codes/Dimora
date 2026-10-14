(() => {
  "use strict";

  const forms = document.querySelectorAll(".needs-validation");

  // Loop over them and prevent submission
  Array.from(forms).forEach((form) => {
    form.addEventListener(
      "submit",
      (event) => {
        if (!form.checkValidity()) {
          event.preventDefault();
          event.stopPropagation();
        }

        form.classList.add("was-validated");

        // The star rating is a radio group, so Bootstrap cannot show a message
        // for it; show ours when nothing is chosen.
        const ratingFeedback = form.querySelector("[data-rating-feedback]");
        if (ratingFeedback) {
          ratingFeedback.hidden = Boolean(
            form.querySelector('input[name="review[rating]"]:checked'),
          );
        }
      },
      false,
    );
  });
})();
