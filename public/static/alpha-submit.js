/*
 * Progressive enhancement for the alpha application form.
 *
 * Same pattern as static/waitlist-submit.js (issue #143): the form's
 * default `action` is a `mailto:` link, so a browser with JavaScript
 * disabled (or this script failing to load) still produces a usable
 * submission -- that native no-JS path is untouched by this file and
 * stays the safe last resort. When JS runs, this intercepts the submit
 * and POSTs JSON to /api/alpha instead. On success it redirects to
 * /alpha/thanks.
 *
 * On FAILURE this shows an inline error and lets the applicant retry by
 * pressing the same submit button again -- it does NOT call
 * `form.submit()` and does NOT fall through to the mailto action (issue
 * #387). That used to be the fallback: HTMLFormElement.submit() bypasses
 * this handler and triggers the browser's native mailto submit, which
 * serializes every field -- name, email, company, the three consent
 * checkboxes -- as visible x-www-form-urlencoded text in a mail compose
 * window. That is a PII leak, and it is the exact bug this build closes.
 * A failed fetch now leaves the applicant's data exactly where they
 * typed it and tells them what to do next; nothing is ever echoed back
 * in a URL or a compose window on this path.
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
