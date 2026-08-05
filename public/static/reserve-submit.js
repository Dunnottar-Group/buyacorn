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

    fetch("/api/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("reserve endpoint returned " + response.status);
        window.location.href = "/reserve/thanks";
      })
      .catch(function () {
        showError(
          "Something went wrong holding your seat. Please try again in a moment, or email hello@buyacorn.com and we will hold it by hand."
        );
      });
  });
})();
