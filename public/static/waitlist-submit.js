/*
 * Submit handler for the waitlist form (homepage and /example).
 *
 * This POSTs JSON to /api/waitlist and, on a confirmed delivery, sends the
 * visitor to /waitlist/thanks carrying the delivery reference so they can
 * quote it back to us.
 *
 * On FAILURE it shows an inline error that says plainly that the details were
 * NOT sent, and leaves everything the visitor typed exactly where it is so
 * they can press the button again. It does NOT call form.submit() and the
 * form no longer carries a mailto action (issue #779, the #387 class). That
 * used to be the fallback: HTMLFormElement.submit() bypasses this handler and
 * triggers the browser's native mailto submit, which serializes name, email
 * and company as visible x-www-form-urlencoded text into a mail compose
 * window. That is a PII leak. Nothing on this path is ever echoed into a URL
 * or a compose window -- the only thing that ever reaches the URL is the
 * Slack delivery id. A visitor with no JavaScript gets a plain text address
 * on the page instead, with nothing prefilled.
 */
(function () {
  var form = document.getElementById("waitlist-form");
  if (!form) return;

  var errorBox = document.getElementById("waitlist-form-error");

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

  function value(field) {
    return form.elements[field] ? form.elements[field].value || null : null;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearError();

    var payload = {
      name: form.elements["name"].value,
      email: form.elements["email"].value,
      company: form.elements["company"].value,
      source_slug: value("source_slug"),
      referral_text: value("referral_text"),
      website: value("website"),
    };

    fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (data) {
            if (!response.ok || !data || data.ok !== true) {
              var detail =
                data && data.error ? data.error : "the server returned " + response.status;
              throw new Error(detail);
            }
            // Only a Slack-confirmed delivery reaches here. The reference is
            // the delivery id, never anything the visitor typed.
            var ref = data.ref ? String(data.ref) : "";
            window.location.href =
              "/waitlist/thanks" + (ref ? "?ref=" + encodeURIComponent(ref) : "");
          });
      })
      .catch(function (err) {
        showError(
          "Your details were NOT sent: " +
            (err && err.message ? err.message : "the request could not reach us") +
            ". Nothing was saved and no email was opened. Please press the button " +
            "again in a moment, or write to waitlist@buyacorn.com and we will add " +
            "you by hand."
        );
      });
  });
})();
