/*
 * Progressive enhancement for the waitlist form.
 *
 * The form's default `action` is a `mailto:` link, so a browser with
 * JavaScript disabled (or this script failing to load) still produces a
 * usable submission: the visitor's mail client opens with the fields
 * as a plain-text draft. See site/api/waitlist.py for the intended
 * production endpoint and DEPLOY-RUNBOOK.md for what still needs a
 * founder decision before that endpoint is live.
 *
 * When JS runs, this intercepts the submit and POSTs JSON to
 * /api/waitlist instead. On success it redirects to /waitlist/thanks.
 * On failure it lets the mailto fallback fire.
 */
(function () {
  var form = document.getElementById("waitlist-form");
  if (!form) return;

  form.addEventListener("submit", function (event) {
    var endpoint = "/api/waitlist";
    var payload = {
      name: form.elements["name"].value,
      email: form.elements["email"].value,
      company: form.elements["company"].value,
      source_slug: form.elements["source_slug"] ? form.elements["source_slug"].value || null : null,
      referral_text: form.elements["referral_text"] ? form.elements["referral_text"].value || null : null,
    };

    event.preventDefault();

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("waitlist endpoint returned " + response.status);
        window.location.href = "/waitlist/thanks";
      })
      .catch(function () {
        // Endpoint unavailable or not yet deployed: fall back to the
        // form's own mailto action instead of leaving the visitor stuck.
        // HTMLFormElement.submit() does not re-dispatch the "submit"
        // event, so this cannot loop back into this same handler.
        form.submit();
      });
  });
})();
