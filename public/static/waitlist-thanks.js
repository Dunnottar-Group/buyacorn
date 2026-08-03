/*
 * Shows the delivery reference on /waitlist/thanks (issue #779).
 *
 * api/waitlist.js returns the Slack message ts of the delivered request, and
 * static/waitlist-submit.js passes it here as ?ref=. That id is the ONLY
 * thing that ever travels in the URL on this path: no name, no email, no
 * company. Anything that does not look like a delivery id is ignored rather
 * than rendered, and the value is written with textContent, so a crafted URL
 * cannot inject markup into this page.
 */
(function () {
  var el = document.getElementById("waitlist-ref");
  if (!el) return;

  var match = /[?&]ref=([^&#]+)/.exec(window.location.search);
  if (!match) return;

  var ref;
  try {
    ref = decodeURIComponent(match[1]);
  } catch (e) {
    return;
  }
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(ref)) return;

  el.textContent = "Your reference is " + ref + ". Quote it if you write to us.";
  el.hidden = false;
})();
