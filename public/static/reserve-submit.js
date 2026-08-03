/*
 * Progressive enhancement for the Founding Member seat reservation form.
 *
 * Same pattern as static/alpha-submit.js, with one deliberate difference: this
 * form carries NO `mailto:` action at all, not even as a no-JS fallback. A
 * reservation carries a name, a work email, a company, and a plan choice, and
 * HTMLFormElement's native mailto submit serializes every one of those into a
 * visible compose window as x-www-form-urlencoded text. That is the PII leak
 * closed by issue #387 on the alpha form. Rather than add the hazard back and
 * then guard it, the action is absent: the page's own fallback note tells a
 * no-JS visitor to email hello@buyacorn.com with the details they choose to
 * share.
 *
 * On FAILURE this shows an inline error and lets the buyer press the same
 * button again. It never calls form.submit(), and it never invents a reason
 * for the failure it cannot see.
 */
(function () {
  var form = document.getElementById("reserve-form");
  if (!form) return;

  var errorBox = document.getElementById("reserve-form-error");

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

  function selectedPlan() {
    var chosen = form.querySelector('input[name="plan"]:checked');
    return chosen ? chosen.value : "";
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearError();

    if (!selectedPlan()) {
      showError("Please choose one of the three options above.");
      return;
    }

    var payload = {
      name: form.elements["name"].value,
      email: form.elements["email"].value,
      company: form.elements["company"].value,
      plan: selectedPlan(),
      notes: form.elements["notes"] ? form.elements["notes"].value || null : null,
      source_slug: form.elements["source_slug"] ? form.elements["source_slug"].value || null : null,
      terms_ack: form.elements["terms_ack"] ? form.elements["terms_ack"].checked : false,
      no_charge_ack: form.elements["no_charge_ack"] ? form.elements["no_charge_ack"].checked : false,
    };

    function reserveOnly() {
      return fetch("/api/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function (response) {
        if (!response.ok) throw new Error("reserve endpoint returned " + response.status);
        window.location.href = "/reserve/thanks";
      });
    }

    // ACR-907: "hold a seat, decide later" is a reservation and must never
    // reach a card form. That is the founder's ruling, enforced here AND
    // server-side in checkout.js, which 400s the same case. Two gates, because
    // this one lives in a file any buyer can edit in their own browser.
    if (selectedPlan() === "undecided") {
      reserveOnly().catch(function () {
        showError(
          "Something went wrong holding your seat. Please try again in a moment, or email hello@buyacorn.com and we will hold it by hand."
        );
      });
      return;
    }

    // A paid plan goes to Stripe Checkout for the $2,500 deposit.
    fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        // 503 is checkout.js's designed answer when no STRIPE_SECRET_KEY is
        // set. Falling back to a plain reservation means a key rotation, a
        // failed deploy, or a deliberate switch-off degrades to "seat held, no
        // money taken" instead of a dead button on a commercial page. The
        // buyer still lands somewhere honest.
        if (response.status === 503) return reserveOnly();

        return response.json().then(function (body) {
          if (!response.ok || !body || !body.url) {
            // Never invent a reason. If Stripe refused and said why, the
            // buyer is told exactly that; otherwise they are told nothing
            // rather than a guess.
            throw new Error((body && body.error) || "checkout returned " + response.status);
          }
          window.location.href = body.url;
        });
      })
      .catch(function (err) {
        showError(
          (err && err.message ? err.message + " " : "") +
            "We could not open the payment page. Please try again in a moment, or email hello@buyacorn.com and we will hold your seat by hand."
        );
      });
  });
})();
