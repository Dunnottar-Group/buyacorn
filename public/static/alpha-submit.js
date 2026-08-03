/*
 * Progressive enhancement for the alpha application form.
 *
 * This is the ONLY submit path. The form carries no `action` and no
 * `method` at all (issue #825), so there is no native browser submit to
 * fall through to: this script intercepts the submit event and POSTs
 * JSON to /api/alpha. On success it redirects to /alpha/thanks. With JS
 * dead the form does nothing, and the page's form-fallback-note tells
 * the applicant to email alpha@buyacorn.com directly -- a plain address
 * carrying nothing prefilled. Same shape as /reserve (ACR-790) and the
 * waitlist form (ACR-779).
 *
 * The form USED to carry `method="POST" action="mailto:alpha@buyacorn.com"`.
 * That native no-JS path serialized every field -- name, email, company,
 * and the three consent checkboxes -- into a mail compose window as
 * visible x-www-form-urlencoded text. Issue #387 removed the JS half of
 * that leak (the `form.submit()` call this file made on a failed fetch,
 * which bypasses this handler and triggers the native submit directly).
 * #387 left the `action` attribute in place, so a visitor with JS
 * disabled, or one whose browser failed to load this file, still hit the
 * compose window. #825 removed the attribute, closing the other half.
 *
 * So: this file must never call `form.submit()` (that is #387's gate,
 * enforced by tests/site_launch/test_acr387_alpha_selfserve.py), and the
 * rendered form must never carry a `mailto:` action (that is #825's
 * gate, enforced by tests/site_launch/test_acr825_alpha_no_mailto.py).
 * On FAILURE this shows an inline error and lets the applicant retry by
 * pressing the same submit button again. A failed fetch leaves the
 * applicant's data exactly where they typed it and tells them what to do
 * next; nothing is ever echoed back in a URL or a compose window.
 */
(function () {
  var form = document.getElementById("alpha-form");
  if (!form) return;

  var errorBox = document.getElementById("alpha-form-error");

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearError();

    var endpoint = "/api/alpha";
    var payload = {
      name: form.elements["name"].value,
      email: form.elements["email"].value,
      company: form.elements["company"].value,
      source_slug: form.elements["source_slug"] ? form.elements["source_slug"].value || null : null,
      referral_text: form.elements["referral_text"] ? form.elements["referral_text"].value || null : null,
      eula_accepted: form.elements["eula_accepted"] ? form.elements["eula_accepted"].checked : false,
      auto_update_ack: form.elements["auto_update_ack"] ? form.elements["auto_update_ack"].checked : false,
      data_share_tier3_ack: form.elements["data_share_tier3_ack"] ? form.elements["data_share_tier3_ack"].checked : false,
    };

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("alpha endpoint returned " + response.status);
        window.location.href = "/alpha/thanks";
      })
      .catch(function () {
        // Endpoint unavailable, not yet deployed, or it rejected the
        // submission: tell the applicant inline and let them press
        // "Apply for the alpha" again once the problem clears. This does
        // NOT call form.submit() and does NOT read the mailto action --
        // see the file header for why that path is gone.
        showError(
          "Something went wrong submitting your application. Please try again in a moment."
        );
      });
  });
})();
