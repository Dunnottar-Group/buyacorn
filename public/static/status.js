/*
 * buyacorn.com/status walkthrough (issue #227; UX round 2 per issue #270).
 *
 * The FULL ordered, grouped walkthrough (AWS account, server/EC2, keys,
 * workspace, both Slack apps, and every step after) is rendered
 * SERVER-SIDE by site/lib/status_walkthrough.py into #status-steps, so it
 * is visible with no JavaScript and no magic-link token at all. This file
 * only ENHANCES what is already on the page:
 *
 *   1. Reads the magic-link token from the URL (?token=...).
 *   2. If a token is present, calls GET /api/status?token=... and, for
 *      every per-user boolean returned, finds the matching
 *      data-step-id/data-member-ids element already in the DOM and layers
 *      a "your server confirmed this" marker on top. It never rebuilds the
 *      walkthrough from scratch.
 *   3. If no token is present, shows the "get your link" email form. The
 *      walkthrough underneath stays exactly as rendered -- every step
 *      pending, which is the honest state for a visitor with no box yet.
 *   4. Progressive disclosure: exactly one phase (the first not-done one)
 *      is expanded; done phases collapse to a green summary line; future
 *      phases collapse gray. Any phase opens on click. With no JS the page
 *      stays fully expanded, which is the no-JS baseline.
 *   5. Dual-model microcopy: box-verified steps say "your server confirmed
 *      this"; a user claim says "you marked this done, waiting for your
 *      server"; user-confirmed-only steps say "confirmed by you". The
 *      phrase "box-verified" never appears in the UI.
 *   6. Stuck / return / celebration states, per-phase attention minutes,
 *      and a per-phase help panel driven by a baked-in FAQ map (no LLM, no
 *      network).
 *   7. Wires [data-tawk-open] elements (ACR-283 part 2) to open the live
 *      Tawk.to chat widget embedded at the bottom of the page template,
 *      falling back to the element's own book-a-call href whenever the
 *      widget is not ready. See wireTawkOpenLinks() below.
 *   8. Wires the open-Secrets-Manager checkbox in the keys phase: a
 *      JS-only progressive-disclosure collapse/expand on the Anthropic
 *      key step's how-to (PR #259 review feedback). The collapse class
 *      is added by this script, never rendered server-side, so the
 *      static, no-JS page always shows every step's full content.
 *   9. Finale "Open #acorn" deep link (#292). Reads the workspace step's
 *      own input value (#status-workspace-url -- no new storage), builds
 *      a real https://<workspace>.slack.com/app_redirect?channel=acorn
 *      href, new tab, once normalizeWorkspaceDomain() confirms it looks
 *      like a genuine Slack workspace host. Anything else keeps the
 *      button in its inactive, clearly labelled state; the button's href
 *      in that state is an in-page anchor back to the workspace field, so
 *      it is never a dead link.
 *  10. Admin fork on both Slack app phases (#275). wireAdminFork()
 *      collapses the not-admin branch only for the default "yes" radio,
 *      the same collapse-only-by-script pattern as #8 above -- the
 *      forwardable IT message stays visible with no JS.
 *      wireAdminForkSentButtons() sets its own distinct pending sentence
 *      ("Waiting on your IT team") when a visitor clicks "I sent this to
 *      my IT team", never touching the real box-verified green.
 *
 * 11. Onboarding-journey beacons (issue #409, front-end + ingest slice).
 *     The founder principle behind this issue: "signal at each stage of
 *     the process so Stonehaven knows where EVERYONE is" -- the meta-fix
 *     for Anna Leigh getting hard-stuck at /status step 2 with no one at
 *     HQ knowing until she said so. sendJourneyBeacon() fires a
 *     fire-and-forget POST to /api/journey at (a) page open, on the
 *     visitor's current stage, (b) every phase transition this file
 *     already observes turning done (markSubstepDone / markPhaseDone /
 *     confirmUserPhase), and (c) every manual "I did this" claim click
 *     (wireConfirmButtons / wireKeyClaimButtons), using navigator.send
 *     Beacon with a fetch(keepalive) fallback. Every call is wrapped so a
 *     beacon can never throw, block, or otherwise touch the wizard --
 *     see sendJourneyBeacon()'s own comment. No token means no beacon (a
 *     visitor with no magic link yet has nothing to attribute a stage
 *     to). This is the FRONT-END + INGEST half only; the join with box
 *     telemetry into the fleet-funnel dashboard (#397) is separate,
 *     later work.
 *
 * 12. Deferred optional steps (issue #496, founder directive 2026-07-27:
 *     "asking for only one key is better. the fewer questions we ask,
 *     the better"). The box requires ONE provider key, so the Grok and
 *     Gemini key steps now render in their own deferred block after the
 *     finale, outside the phase rail entirely -- no .status-phase, no
 *     .status-substep, no data-minutes, so allPhases(),
 *     recomputeProgress(), refreshDisclosure(), and updateChrome() never
 *     see them and an optional key can never count toward required
 *     progress or hold the celebration back. applyOptionalKeyState()
 *     greens those rows if the user does add a key later, and the
 *     verification panel gains an "optional" state that is never
 *     await-clocked and never escalates to the oak-brown "stale" -- an
 *     absent optional key produces no red state anywhere on this page.
 *
 * The status/consent API calls are same-origin. The one exception is the
 * Tawk.to chat widget script (ACR-283 part 2, founder-approved embed),
 * loaded by the page template, never by this file.
 */
(function () {
  "use strict";

  var AWAIT_STUCK_MS = 15 * 60 * 1000; // 15 minutes
  var AWAIT_KEY_PREFIX = "acorn_status_await_";

  function byId(id) {
    return document.getElementById(id);
  }

  function getToken() {
    try {
      return new URLSearchParams(window.location.search).get("token");
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Onboarding-journey beacons (issue #409). See file header note 11.
  // ---------------------------------------------------------------------

  // A phase's real catalog step_id(s), read from the same data attributes
  // applyBoxVerifiedState() already reads: a solo phase carries
  // data-step-id (one real onboarding_steps.json step_id); a phase with
  // substeps carries data-member-ids (a comma list of real step_ids).
  // Returns [] when neither is present -- nothing to beacon.
  function resolveStepIds(phaseEl) {
    if (!phaseEl) return [];
    var single = phaseEl.getAttribute("data-step-id");
    if (single) return [single];
    var memberIdsAttr = phaseEl.getAttribute("data-member-ids");
    if (memberIdsAttr) return memberIdsAttr.split(",");
    return [];
  }

  // Fire-and-forget: POSTs {token, stage_id, ts} to /api/journey. Never
  // throws, never blocks, never retries -- a beacon is a best-effort
  // signal, not a guaranteed delivery, and /api/journey being slow,
  // offline, or erroring must never touch the wizard (issue #409's own
  // requirement). navigator.sendBeacon is preferred (survives page
  // unload); a keepalive fetch is the fallback for browsers without it or
  // when sendBeacon itself reports failure to queue.
  function sendJourneyBeacon(stageId) {
    try {
      if (!stageId) return;
      var token = getToken();
      if (!token) return; // no magic-link token yet: nothing to attribute a stage to
      var body = JSON.stringify({ token: token, stage_id: stageId, ts: new Date().toISOString() });

      var queued = false;
      try {
        if (navigator.sendBeacon) {
          queued = navigator.sendBeacon("/api/journey", body);
        }
      } catch (e) {
        queued = false;
      }
      if (queued) return;

      try {
        fetch("/api/journey", { method: "POST", body: body, keepalive: true }).catch(function () {});
      } catch (e) {
        /* no navigator.sendBeacon and fetch itself threw: drop the beacon, wizard is unaffected */
      }
    } catch (e) {
      /* a beacon must never be able to break the page it is reporting on */
    }
  }

  function beaconStage(stageId) {
    sendJourneyBeacon(stageId);
  }

  function beaconStages(stageIds) {
    if (!stageIds) return;
    for (var i = 0; i < stageIds.length; i++) {
      sendJourneyBeacon(stageIds[i]);
    }
  }

  // Basic CSS.escape polyfill -- step_ids are ASCII snake_case.
  function cssEscape(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function allPhases() {
    return document.querySelectorAll(".status-phase");
  }

  function isBoxVerified(phaseEl) {
    return phaseEl.getAttribute("data-completion") === "box_verified";
  }

  function phaseIsDone(phaseEl) {
    if (isBoxVerified(phaseEl)) {
      // status-phase-server-manual-advance is the LIVE ALPHA BLOCKER
      // fallback (see wireServerManualAdvance() below): a user
      // self-attestation on the server phase only, added when the
      // box-verified auto-signal is not available in production. The
      // real box-verified green (status-phase-is-done) still wins the
      // moment the box actually checks in -- see markPhaseDone().
      return (
        phaseEl.classList.contains("status-phase-is-done") ||
        phaseEl.classList.contains("status-phase-server-manual-advance")
      );
    }
    return phaseEl.classList.contains("status-phase-user-confirmed-final");
  }

  // ---------------------------------------------------------------------
  // Box-verified overlay
  // ---------------------------------------------------------------------

  function markSubstepDone(stepId) {
    // Beacon before the DOM-element early return: this is a real phase
    // transition (a server-verified step turning done) regardless of
    // whether this particular render has a literal .status-substep
    // element for it (issue #409, phase-transition beacon).
    beaconStage(stepId);
    var el = document.querySelector('.status-substep[data-step-id="' + cssEscape(stepId) + '"]');
    if (!el) return;
    el.classList.add("status-substep-is-done");
    el.classList.remove("status-substep-awaiting");
    var marker = el.querySelector(".status-substep-marker");
    if (marker) marker.textContent = "✓";
    var claimButton = el.querySelector(".status-claim-button");
    if (claimButton) claimButton.hidden = true;
  }

  function setStatusSentence(phaseEl, text) {
    var status = phaseEl.querySelector(".status-phase-status");
    if (status) status.textContent = text;
  }

  function markPhaseDone(phaseEl) {
    // Phase-transition beacon (issue #409). May duplicate a beacon
    // markSubstepDone() already sent for the same step_id(s) when every
    // member just turned done -- replay is explicitly tolerated by
    // /api/journey (same stage twice is fine), so completeness wins over
    // avoiding the overlap.
    beaconStages(resolveStepIds(phaseEl));
    phaseEl.classList.remove("status-phase-awaiting-verification");
    phaseEl.classList.add("status-phase-is-done");
    // The real green supersedes the manual-advance self-attestation, if
    // present -- clear it so the honest, box-verified sentence below is
    // the only one showing.
    phaseEl.classList.remove("status-phase-server-manual-advance");
    clearServerManualAdvance();
    var marker = phaseEl.querySelector(".status-phase-marker");
    if (marker) marker.textContent = "✓";
    setStatusSentence(phaseEl, "Your server confirmed this.");
    var confirmButton = phaseEl.querySelector(".status-confirm-button");
    if (confirmButton) confirmButton.hidden = true;
    var awaitingNote = phaseEl.querySelector(".status-awaiting-note");
    if (awaitingNote) awaitingNote.hidden = true;
    var stuck = phaseEl.querySelector(".status-stuck");
    if (stuck) stuck.hidden = true;
    var manualAdvance = phaseEl.querySelector(".status-server-manual-advance");
    if (manualAdvance) manualAdvance.hidden = true;
    clearAwait(phaseEl.getAttribute("data-phase-id"));
  }

  // Applies the per-user booleans onto the server-rendered walkthrough.
  function applyBoxVerifiedState(doneMap) {
    Array.prototype.forEach.call(allPhases(), function (phaseEl) {
      if (!isBoxVerified(phaseEl)) return; // user-confirmed phases never take telemetry green
      var singleId = phaseEl.getAttribute("data-step-id");
      var memberIdsAttr = phaseEl.getAttribute("data-member-ids");

      if (memberIdsAttr) {
        var memberIds = memberIdsAttr.split(",");
        var allDone = true;
        memberIds.forEach(function (id) {
          var done = !!doneMap[id];
          if (done) markSubstepDone(id);
          if (!done) allDone = false;
        });
        if (allDone) markPhaseDone(phaseEl);
        return;
      }

      if (singleId && doneMap[singleId]) {
        markPhaseDone(phaseEl);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Progress bar + "Step N of M" + minutes-left chrome
  // ---------------------------------------------------------------------

  function renderProgress(total, done) {
    var totalEl = byId("status-total-count");
    var doneEl = byId("status-done-count");
    if (totalEl) totalEl.textContent = String(total);
    if (doneEl) doneEl.textContent = String(done);
    var fill = byId("status-bar-fill");
    if (fill) fill.style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
  }

  function recomputeProgress() {
    // Count every box-verified substep, and every box-verified solo phase
    // (those without substeps). User-confirmed phases are never counted as
    // server progress.
    var total = 0;
    var done = 0;
    Array.prototype.forEach.call(document.querySelectorAll(".status-substep"), function (el) {
      total += 1;
      if (el.classList.contains("status-substep-is-done")) done += 1;
    });
    Array.prototype.forEach.call(allPhases(), function (phaseEl) {
      if (!isBoxVerified(phaseEl)) return;
      if (phaseEl.querySelector(".status-substep")) return; // counted via substeps
      if (!phaseEl.getAttribute("data-step-id")) return;
      total += 1;
      if (phaseEl.classList.contains("status-phase-is-done")) done += 1;
    });
    renderProgress(total, done);
  }

  function updateChrome(phases, currentIndex) {
    var stepN = byId("status-step-n");
    var minutesLeft = byId("status-minutes-left");
    var doneCount = 0;
    var minutes = 0;
    Array.prototype.forEach.call(phases, function (phaseEl) {
      if (phaseIsDone(phaseEl)) {
        doneCount += 1;
      } else {
        minutes += parseInt(phaseEl.getAttribute("data-minutes"), 10) || 0;
      }
    });
    if (stepN) {
      stepN.textContent = String(
        currentIndex >= 0 ? currentIndex + 1 : phases.length
      );
    }
    if (minutesLeft) minutesLeft.textContent = String(minutes);
  }

  // ---------------------------------------------------------------------
  // Progressive disclosure + dual-model sentences
  // ---------------------------------------------------------------------

  var manuallyOpen = {};

  function setCollapsed(phaseEl, collapsed) {
    phaseEl.classList.toggle("status-phase-collapsed", collapsed);
  }

  function refreshDisclosure() {
    var phases = allPhases();
    var currentIndex = -1;
    Array.prototype.forEach.call(phases, function (phaseEl, i) {
      if (currentIndex === -1 && !phaseIsDone(phaseEl)) currentIndex = i;
    });

    Array.prototype.forEach.call(phases, function (phaseEl, i) {
      var phaseId = phaseEl.getAttribute("data-phase-id");
      var done = phaseIsDone(phaseEl);
      var current = i === currentIndex;
      phaseEl.classList.toggle("status-phase-done", done);
      phaseEl.classList.toggle("status-phase-current", current);
      phaseEl.classList.toggle("status-phase-locked", !done && !current);

      // Pending status sentence (done/awaiting sentences are set by their
      // own handlers so they are not overwritten here). status-phase-it-
      // notified is its own distinct pending sentence too (#275): once a
      // visitor has sent the forwardable message to their IT team, this
      // disclosure pass must not stomp "Waiting on your IT team" back to
      // the generic "Waiting on your server."
      if (!done && !phaseEl.classList.contains("status-phase-awaiting-verification") &&
          !phaseEl.classList.contains("status-phase-user-confirmed-final") &&
          !phaseEl.classList.contains("status-phase-it-notified")) {
        setStatusSentence(
          phaseEl,
          isBoxVerified(phaseEl) ? "Waiting on your server." : "Waiting for you to confirm."
        );
      }

      if (manuallyOpen[phaseId]) {
        setCollapsed(phaseEl, false);
      } else {
        setCollapsed(phaseEl, !current);
      }
    });

    updateChrome(phases, currentIndex);
    updateChatbotForCurrent();
    checkAwaitTimers();
    updateCompletionState(phases);

    return { phases: phases, currentIndex: currentIndex };
  }

  function scrollToCurrentOnce(currentIndex) {
    // Only scroll when there is real progress to return to -- a fresh page
    // with nothing done stays at the welcome block.
    var phases = allPhases();
    var doneAny = false;
    Array.prototype.forEach.call(phases, function (p) {
      if (phaseIsDone(p)) doneAny = true;
    });
    if (!doneAny || currentIndex < 0) return;
    var target = phases[currentIndex];
    if (target && target.scrollIntoView) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function wirePhaseHeadToggles() {
    Array.prototype.forEach.call(allPhases(), function (phaseEl) {
      var head = phaseEl.querySelector(".status-phase-head");
      if (!head || head.dataset.wired) return;
      head.dataset.wired = "1";
      head.style.cursor = "pointer";
      head.addEventListener("click", function () {
        var phaseId = phaseEl.getAttribute("data-phase-id");
        var nowCollapsed = phaseEl.classList.toggle("status-phase-collapsed");
        manuallyOpen[phaseId] = !nowCollapsed;
      });
    });
  }

  // ---------------------------------------------------------------------
  // Stuck / return state (localStorage timestamp, revealed after 15 min)
  // ---------------------------------------------------------------------

  function setAwait(phaseId) {
    if (!phaseId) return;
    try {
      if (!window.localStorage.getItem(AWAIT_KEY_PREFIX + phaseId)) {
        window.localStorage.setItem(AWAIT_KEY_PREFIX + phaseId, String(Date.now()));
      }
    } catch (e) {
      /* private mode / storage disabled: stuck state simply never fires */
    }
  }

  function clearAwait(phaseId) {
    if (!phaseId) return;
    try {
      window.localStorage.removeItem(AWAIT_KEY_PREFIX + phaseId);
    } catch (e) {
      /* ignore */
    }
  }

  function checkAwaitTimers() {
    Array.prototype.forEach.call(allPhases(), function (phaseEl) {
      var stuck = phaseEl.querySelector(".status-stuck");
      if (!stuck) return;
      var phaseId = phaseEl.getAttribute("data-phase-id");
      if (phaseIsDone(phaseEl)) {
        stuck.hidden = true;
        return;
      }
      // A stuck-capable phase that is current starts its own clock.
      if (phaseEl.classList.contains("status-phase-current")) setAwait(phaseId);
      var started = null;
      try {
        started = window.localStorage.getItem(AWAIT_KEY_PREFIX + phaseId);
      } catch (e) {
        started = null;
      }
      if (started && Date.now() - parseInt(started, 10) > AWAIT_STUCK_MS) {
        stuck.hidden = false;
      }
    });
  }

  // ---------------------------------------------------------------------
  // Completion: health line + celebration
  // ---------------------------------------------------------------------

  function updateCompletionState(phases) {
    var allDone = phases.length > 0;
    Array.prototype.forEach.call(phases, function (phaseEl) {
      if (!phaseIsDone(phaseEl)) allDone = false;
    });
    var health = byId("status-health");
    var goLive = document.querySelector('.status-phase[data-phase-id="go_live"]');
    var celebration = goLive ? goLive.querySelector(".status-celebration") : null;
    if (allDone) {
      if (health) {
        health.hidden = false;
        var line = health.querySelector(".status-health-line");
        if (line) line.textContent = "Your Acorn: alive";
      }
      if (celebration) celebration.hidden = false;
      if (goLive) {
        goLive.classList.add("status-phase-celebrate");
        setCollapsed(goLive, false);
      }
      document.body.classList.add("status-complete");
    } else {
      if (health) health.hidden = true;
      if (celebration) celebration.hidden = true;
      if (goLive) goLive.classList.remove("status-phase-celebrate");
      document.body.classList.remove("status-complete");
    }
  }

  // ---------------------------------------------------------------------
  // User-confirmed affordances: a click is a claim, telemetry is proof.
  // ---------------------------------------------------------------------

  function confirmUserPhase(phaseEl) {
    // Phase-transition beacon (issue #409): a user_confirmed phase (e.g.
    // aws_account, workspace) reaches its own "done" purely through this
    // call, with no separate box-verified signal ever coming later.
    beaconStages(resolveStepIds(phaseEl));
    phaseEl.classList.add("status-phase-user-confirmed-final");
    var marker = phaseEl.querySelector(".status-phase-marker");
    if (marker) marker.textContent = "✓";
    setStatusSentence(phaseEl, "Confirmed by you.");
  }

  function wireWorkspaceForm() {
    var form = byId("status-workspace-form");
    if (!form || form.dataset.wired) return;
    form.dataset.wired = "1";

    var radios = document.querySelectorAll('input[name="workspace-choice"]');
    var needBranch = document.querySelector(".status-workspace-branch-need");
    Array.prototype.forEach.call(radios, function (radio) {
      radio.addEventListener("change", function () {
        if (needBranch) needBranch.hidden = radio.value !== "need" || !radio.checked;
      });
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var urlField = byId("status-workspace-url");
      if (!urlField || !urlField.value.trim()) return;
      var phaseEl = form.closest(".status-phase");
      form.hidden = true;
      var confirmed = byId("status-workspace-confirmed");
      if (confirmed) confirmed.hidden = false;
      if (phaseEl) confirmUserPhase(phaseEl);
      updateOpenAcornButton();
      refreshDisclosure();
    });
  }

  function wireAwsCheckbox() {
    var checkbox = byId("status-aws-checkbox");
    if (!checkbox || checkbox.dataset.wired) return;
    checkbox.dataset.wired = "1";

    var radios = document.querySelectorAll('input[name="aws-choice"]');
    var needBranch = document.querySelector(".status-aws-branch-need");
    Array.prototype.forEach.call(radios, function (radio) {
      radio.addEventListener("change", function () {
        if (needBranch) needBranch.hidden = radio.value !== "need" || !radio.checked;
      });
    });

    checkbox.addEventListener("change", function () {
      var phaseEl = checkbox.closest(".status-phase");
      if (!phaseEl) return;
      if (checkbox.checked) {
        confirmUserPhase(phaseEl);
      } else {
        phaseEl.classList.remove("status-phase-user-confirmed-final");
        setStatusSentence(phaseEl, "Waiting for you to confirm.");
      }
      refreshDisclosure();
    });
  }

  // -----------------------------------------------------------------
  // LIVE ALPHA BLOCKER fallback (server phase, 2026-07-24): the server
  // phase's box-verified auto-signal depends on FLEET_STATUS_S3_URL,
  // unset in production, so it never turns done there and every later
  // phase stays locked forever. This checkbox is the founder-ordered
  // fallback -- a user SELF-ATTESTATION, never a verification -- and
  // reuses the exact mechanism wireAwsCheckbox()/
  // wireOpenSecretsManagerCheckbox() already use: a checkbox, wired
  // here, that adds one class phaseIsDone() already treats as done
  // (see above). The auto-detect path is untouched: markPhaseDone()
  // still fires from real telemetry and supersedes this state the
  // moment the box actually checks in.
  //
  // Persistence: localStorage, same mechanism family as the stuck-timer
  // await keys above, so a page refresh does not re-lock the rail on a
  // visitor who already attested.
  // -----------------------------------------------------------------

  var SERVER_MANUAL_ADVANCE_KEY = "acorn_status_server_manual_advance";

  function setServerManualAdvance() {
    try {
      window.localStorage.setItem(SERVER_MANUAL_ADVANCE_KEY, "1");
    } catch (e) {
      /* private mode / storage disabled: the attestation simply does not
         survive a refresh -- the checkbox itself still works this visit */
    }
  }

  function clearServerManualAdvance() {
    try {
      window.localStorage.removeItem(SERVER_MANUAL_ADVANCE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function hasServerManualAdvance() {
    try {
      return window.localStorage.getItem(SERVER_MANUAL_ADVANCE_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function markServerManualAdvance(phaseEl) {
    phaseEl.classList.add("status-phase-server-manual-advance");
    var marker = phaseEl.querySelector(".status-phase-marker");
    if (marker) marker.textContent = "✓";
    setStatusSentence(
      phaseEl,
      "Confirmed by you. Your server has not checked in on its own yet."
    );
  }

  function wireServerManualAdvance() {
    var checkbox = byId("status-server-manual-advance-checkbox");
    if (!checkbox || checkbox.dataset.wired) return;
    checkbox.dataset.wired = "1";
    var phaseEl = checkbox.closest(".status-phase");
    if (!phaseEl) return;

    // Restore a persisted attestation across a refresh -- unless the box
    // already confirmed this for real in the meantime, in which case the
    // real green stays the only signal.
    if (hasServerManualAdvance() && !phaseEl.classList.contains("status-phase-is-done")) {
      checkbox.checked = true;
      markServerManualAdvance(phaseEl);
    }

    checkbox.addEventListener("change", function () {
      if (phaseEl.classList.contains("status-phase-is-done")) return; // server already confirmed it for real
      if (checkbox.checked) {
        setServerManualAdvance();
        markServerManualAdvance(phaseEl);
      } else {
        clearServerManualAdvance();
        phaseEl.classList.remove("status-phase-server-manual-advance");
        setStatusSentence(phaseEl, "Waiting on your server.");
      }
      refreshDisclosure();
    });
  }

  function wireConfirmButtons() {
    // Box-verified "I did this" claims (Slack apps, channels). The
    // workspace confirm is a form submit handled separately.
    var buttons = document.querySelectorAll('[data-confirm-phase]:not([data-confirm-phase="workspace"])');
    Array.prototype.forEach.call(buttons, function (button) {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", function () {
        var phaseEl = button.closest(".status-phase");
        if (!phaseEl) return;
        if (phaseEl.classList.contains("status-phase-is-done")) return; // server already confirmed it
        // Manual-advance click beacon (issue #409): the user's claim,
        // recorded the moment they make it -- independent of whether the
        // server later confirms it via markPhaseDone's own beacon.
        beaconStages(resolveStepIds(phaseEl));
        phaseEl.classList.add("status-phase-awaiting-verification");
        button.hidden = true;
        var awaitingNote = phaseEl.querySelector(".status-awaiting-note");
        if (awaitingNote) awaitingNote.hidden = false;
        setStatusSentence(phaseEl, "You marked this done. Waiting for your server to confirm.");
        setAwait(phaseEl.getAttribute("data-phase-id"));
        refreshDisclosure();
      });
    });
  }

  function wireKeyClaimButtons() {
    var buttons = document.querySelectorAll("[data-claim-step]");
    Array.prototype.forEach.call(buttons, function (button) {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", function () {
        var li = button.closest(".status-substep");
        if (!li || li.classList.contains("status-substep-is-done")) return;
        // Manual-advance click beacon (issue #409): data-claim-step is
        // already the exact real step_id (e.g. "anthropic_key"), the most
        // precise signal available for this click -- no phase-level
        // resolution needed.
        beaconStage(button.getAttribute("data-claim-step"));
        li.classList.add("status-substep-awaiting");
        button.hidden = true;
        var phaseEl = button.closest(".status-phase");
        if (phaseEl) setAwait(phaseEl.getAttribute("data-phase-id"));
        checkAwaitTimers();
      });
    });
  }

  function wireAdminFork() {
    // #275: "Are you a Slack admin?" fork on both app phases. The
    // not-admin branch renders fully expanded in the static markup (no
    // `hidden` attribute -- the no-JS baseline this issue asks for); this
    // function is the ONLY thing that ever collapses it, and only for the
    // default "yes" state, mirroring wireOpenSecretsManagerCheckbox()'s
    // own collapse-only-by-script pattern for the Anthropic key how-to.
    var forks = document.querySelectorAll("[data-admin-fork]");
    Array.prototype.forEach.call(forks, function (fork) {
      if (fork.dataset.wired) return;
      fork.dataset.wired = "1";
      var branch = fork.querySelector('[data-admin-fork-branch="no"]');
      if (!branch) return;
      branch.classList.add("status-admin-fork-collapsed");
      var radios = fork.querySelectorAll('input[type="radio"]');
      Array.prototype.forEach.call(radios, function (radio) {
        radio.addEventListener("change", function () {
          branch.classList.toggle("status-admin-fork-collapsed", radio.value !== "no" || !radio.checked);
        });
      });
    });
  }

  function wireAdminForkSentButtons() {
    // #275: "I sent this to my IT team" sets its own distinct pending
    // sentence. Box verification is untouched -- the real green still
    // only ever comes from the server's own read of the Slack side once
    // the app answers, same as the phase's existing "I have done this"
    // confirm button.
    var buttons = document.querySelectorAll("[data-admin-fork-sent]");
    Array.prototype.forEach.call(buttons, function (button) {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", function () {
        var phaseEl = button.closest(".status-phase");
        if (!phaseEl) return;
        if (phaseEl.classList.contains("status-phase-is-done")) return; // server already confirmed it
        button.hidden = true;
        var branch = button.closest(".status-admin-fork-not-admin");
        var note = branch && branch.querySelector(".status-admin-fork-waiting-note");
        if (note) note.hidden = false;
        phaseEl.classList.add("status-phase-it-notified");
        setStatusSentence(phaseEl, "Waiting on your IT team.");
      });
    });
  }

  function wireStartButton() {
    var start = byId("status-start");
    if (!start) return;
    start.addEventListener("click", function () {
      var first = allPhases()[0];
      if (!first) return;
      var phaseId = first.getAttribute("data-phase-id");
      manuallyOpen[phaseId] = true;
      setCollapsed(first, false);
      if (first.scrollIntoView) first.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function showLinkForm() {
    var section = byId("status-link");
    if (section) section.hidden = false;
    var form = byId("status-link-form");
    if (!form) return;
    form.addEventListener("submit", function () {
      // ACR-778 (fixes #778): let the native submit run. The form's
      // mailto: action is the only transport this page has, so the
      // browser opening a pre-filled email IS everything that happens
      // here, and the note unhidden below says exactly that and nothing
      // more. The old handler preventDefault()ed, POSTed to a magic-link
      // endpoint the deployed site does not serve (fetch() resolves on
      // the 404), and then unhid a panel telling the visitor their link
      // was already headed for their inbox -- a confirmation of a send
      // that never happened, the #441 false-confirmation class. No
      // sent-style claim may return here unless a real, founder-wired
      // delivery response is the thing that unhides it.
      var note = byId("status-link-requested");
      if (note) note.hidden = false;
    });
  }

  // WIDGET_SEAM: the Request-help control and the "Talk to a human" panel
  // item both carry [data-tawk-open] and open the live Tawk.to chat widget
  // (ACR-283 part 2) via wireTawkOpenLinks() below. Every one of these
  // book-a-call links stays a real, working action either way, kept in
  // sync with the same URL this function already applies.
  function updateBookACallLinks(url) {
    if (!url) return;
    var targets = document.querySelectorAll(
      "#status-book-a-call, .status-support-link, .status-chatbot-cta, " +
      ".status-chatbot-talk-human, .status-help-call, .status-stuck-call, " +
      ".status-celebration-cta, .status-verify-support-link"
    );
    Array.prototype.forEach.call(targets, function (el) {
      el.setAttribute("href", url);
    });
  }

  function loadStatus(token) {
    fetch("/api/status?token=" + encodeURIComponent(token), {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        if (response.status === 401 || response.status === 403) {
          showLinkForm();
          throw new Error("unauthorized");
        }
        if (!response.ok) throw new Error("status endpoint returned " + response.status);
        return response.json();
      })
      .then(function (body) {
        if (body && body.book_a_call_url) updateBookACallLinks(body.book_a_call_url);
        if (!body || body.found === false) {
          // Honest degrade (no telemetry row for this client yet): every
          // verification row stays exactly as server-rendered ("Not yet
          // checked."), and its await clock (already started at page
          // load by beginVerifyAwaitClocks) keeps running toward "stale"
          // if this persists -- never a silent, unlabeled wait.
          checkVerifyStaleTimers();
          refreshDisclosure();
          recomputeProgress();
          return;
        }
        var doneMap = {};
        (body.steps || []).forEach(function (s) {
          doneMap[s.step_id] = !!s.done;
        });
        applyBoxVerifiedState(doneMap);
        applyOptionalKeyState(doneMap);
        applyVerificationResults(body.verifications);
        checkVerifyStaleTimers();
        recomputeProgress();
        var state = refreshDisclosure();
        scrollToCurrentOnce(state.currentIndex);
      })
      .catch(function () {
        checkVerifyStaleTimers();
        refreshDisclosure();
        recomputeProgress();
      });
  }

  // Copy buttons for the manifest blocks and the canonical secret names.
  function wireCopyButtons() {
    var buttons = document.querySelectorAll("[data-copy-target]");
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener("click", function () {
        var target = byId(button.getAttribute("data-copy-target"));
        if (!target) return;
        var text = target.textContent;
        var done = function () {
          var original = button.textContent;
          button.textContent = "Copied";
          setTimeout(function () {
            button.textContent = original;
          }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () {});
        } else {
          var range = document.createRange();
          range.selectNodeContents(target);
          var selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          try {
            document.execCommand("copy");
            done();
          } catch (e) {
            /* selection stays for a manual copy */
          }
        }
      });
    });
  }

  // ---------------------------------------------------------------------
  // Per-step help panel (issue #270). Deterministic, labelled question
  // buttons for the current phase, plus an always-visible book-a-call. No
  // free-text input, no LLM, no network.
  // ---------------------------------------------------------------------

  var FAQ_MAP = {};

  function loadFaqMap() {
    var tag = byId("status-support-faq");
    if (!tag) return;
    try {
      var parsed = JSON.parse(tag.textContent);
      FAQ_MAP = (parsed && parsed.faqs) || {};
    } catch (e) {
      FAQ_MAP = {};
    }
  }

  function currentPhaseEl() {
    var phases = allPhases();
    for (var i = 0; i < phases.length; i++) {
      if (!phaseIsDone(phases[i])) return phases[i];
    }
    return phases.length ? phases[phases.length - 1] : null;
  }

  function updateChatbotForCurrent() {
    var phaseEl = currentPhaseEl();
    var titleEl = byId("status-chatbot-phase");
    var listEl = byId("status-chatbot-faqs");
    if (!phaseEl || !titleEl || !listEl) return;
    var phaseId = phaseEl.getAttribute("data-phase-id");
    var phaseTitleNode = phaseEl.querySelector(".status-phase-title");
    var phaseTitle = phaseTitleNode ? phaseTitleNode.textContent : "your setup";
    if (listEl.dataset.phase === phaseId) return; // already rendered for this phase
    listEl.dataset.phase = phaseId;
    titleEl.textContent = "Help with: " + phaseTitle;
    listEl.innerHTML = "";
    var faqs = FAQ_MAP[phaseId] || [];
    faqs.forEach(function (item) {
      var wrap = document.createElement("div");
      wrap.className = "status-faq-item";
      var q = document.createElement("button");
      q.type = "button";
      q.className = "status-faq-q";
      q.textContent = item.q;
      var a = document.createElement("p");
      a.className = "status-faq-a";
      a.textContent = item.a;
      a.hidden = true;
      q.addEventListener("click", function () {
        a.hidden = !a.hidden;
        q.classList.toggle("status-faq-q-open", !a.hidden);
      });
      wrap.appendChild(q);
      wrap.appendChild(a);
      listEl.appendChild(wrap);
    });
  }

  function openChatbot() {
    var panel = byId("status-chatbot-panel");
    if (!panel) return;
    panel.hidden = false;
    updateChatbotForCurrent();
  }

  // CHATBOT_SEAM: this is the whole of today's "bot". It only shows and
  // hides the fixed panel (no floating launcher bubble of its own, #288
  // -- the live Tawk widget owns that corner); the panel's content is
  // the baked-in per-phase FAQ rendered by updateChatbotForCurrent().
  // Wiring a real assistant means replacing that lookup with a
  // request/response flow. Nothing here calls a network endpoint.
  function wireChatbotStub() {
    var panel = byId("status-chatbot-panel");
    var closeButton = byId("status-chatbot-close");
    if (!panel || !closeButton || closeButton.dataset.wired) return;
    closeButton.dataset.wired = "1";
    closeButton.addEventListener("click", function () {
      panel.hidden = true;
    });
  }

  // The panel's only entry points: the setup chrome's "Ask the chat"
  // button and a stuck block's own "Ask the chat" button. No floating
  // bubble of its own, so it never competes with the live Tawk widget's
  // bottom-right corner.
  function wireChatOpeners() {
    var openers = document.querySelectorAll("#status-chrome-chat, .status-stuck-chat");
    Array.prototype.forEach.call(openers, function (el) {
      el.addEventListener("click", openChatbot);
    });
  }

  // ---------------------------------------------------------------------
  // WIDGET_SEAM (ACR-283 part 2): the live Tawk.to chat widget, embedded
  // at the bottom of status_body.html.tmpl. Every element carrying
  // [data-tawk-open] (the Request-help control, the chatbot panel's
  // "Talk to a human" item) tries to open the widget with a real human
  // on the other end, and falls back to its own href -- the site's
  // book-a-call page -- whenever the widget is not ready: blocked,
  // offline, or still loading its async script. Never a dead click
  // either way.
  // ---------------------------------------------------------------------

  // Best-effort "what step is this visitor on" label, passed to Tawk as
  // context before the widget opens. Only reads state already on the
  // page (no new fetch, no new data exposure); if nothing matches, the
  // widget still opens, just without this optional attribute.
  function currentStepContext() {
    var phases = document.querySelectorAll(".status-phase");
    for (var i = 0; i < phases.length; i++) {
      var isDone = phases[i].classList.contains("status-phase-is-done") ||
        phases[i].classList.contains("status-phase-user-confirmed-final");
      if (!isDone) {
        var title = phases[i].querySelector(".status-phase-title");
        if (title && title.textContent.trim()) return title.textContent.trim();
        return phases[i].getAttribute("data-phase-id") || "";
      }
    }
    return "all steps done";
  }

  function wireTawkOpenLinks() {
    var links = document.querySelectorAll("[data-tawk-open]");
    Array.prototype.forEach.call(links, function (link) {
      link.addEventListener("click", function (event) {
        if (!window.Tawk_API || typeof window.Tawk_API.maximize !== "function") {
          // Widget not ready yet: let the link's own href (book-a-call)
          // fire as the fallback. Nothing to prevent, nothing to do.
          return;
        }
        event.preventDefault();
        try {
          window.Tawk_API.setAttributes(
            { "current-step": currentStepContext() },
            function () {}
          );
        } catch (e) {
          /* attribute set failed; still try to open the widget below */
        }
        try {
          window.Tawk_API.maximize();
        } catch (e) {
          // The widget script loaded but maximize() threw: fall back to
          // the same book-a-call href a blocked/offline widget would.
          window.location.href = link.getAttribute("href");
        }
      });
    });
  }

  // ---------------------------------------------------------------------
  // Open-Secrets-Manager checkbox (PR #259 review feedback): a JS-only
  // progressive-disclosure collapse/expand on the Anthropic key how-to.
  //
  // ACR-434 point 7 (issue #434, Anna Leigh's own words: "marking a
  // substep done collapses guidance permanently -- needs re-expand"):
  // before this fix the checkbox's checked state lived only in memory,
  // never in localStorage, so a page refresh (which a visitor does
  // constantly here -- opening AWS in a new tab, coming back, reloading)
  // silently re-collapsed the Anthropic how-to with no visible way back
  // for someone who did not already know re-checking this specific box
  // was the fix. Persisting it the same way SERVER_MANUAL_ADVANCE_KEY
  // already does closes that hole: once checked, it stays expanded
  // across a refresh.
  // ---------------------------------------------------------------------

  var OPEN_SM_CHECKED_KEY = "acorn_status_open_secrets_manager_checked";

  function setOpenSmChecked() {
    try {
      window.localStorage.setItem(OPEN_SM_CHECKED_KEY, "1");
    } catch (e) {
      /* private mode / storage disabled: this visit still works, it
         just will not survive a refresh */
    }
  }

  function clearOpenSmChecked() {
    try {
      window.localStorage.removeItem(OPEN_SM_CHECKED_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function hasOpenSmChecked() {
    try {
      return window.localStorage.getItem(OPEN_SM_CHECKED_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function wireOpenSecretsManagerCheckbox() {
    var reveal = document.querySelectorAll('[data-reveal-after="open_secrets_manager"]');
    if (!reveal.length) return;
    Array.prototype.forEach.call(reveal, function (el) {
      el.classList.add("status-key-howto-collapsed");
    });
    var checkbox = document.querySelector('[data-confirm-checkbox="open_secrets_manager"]');
    if (!checkbox) return;

    function applyChecked(checked) {
      Array.prototype.forEach.call(reveal, function (el) {
        el.classList.toggle("status-key-howto-collapsed", !checked);
      });
      var wrap = checkbox.closest(".status-open-sm-check");
      if (wrap) wrap.classList.toggle("status-open-sm-checked", checked);
    }

    // Restore a persisted "already opened Secrets Manager" state across a
    // refresh, so the Anthropic how-to does not silently re-collapse.
    if (hasOpenSmChecked()) {
      checkbox.checked = true;
      applyChecked(true);
    }

    if (checkbox.dataset.wired) return;
    checkbox.dataset.wired = "1";
    checkbox.addEventListener("change", function () {
      var checked = checkbox.checked;
      if (checked) {
        setOpenSmChecked();
      } else {
        clearOpenSmChecked();
      }
      applyChecked(checked);
    });
  }

  // ---------------------------------------------------------------------
  // Finale "Open #acorn" deep link (#292). See file header note 9.
  // ---------------------------------------------------------------------

  var OPEN_ACORN_INACTIVE_LABEL = "Enter your workspace above and this button lights up";
  var SLACK_DOMAIN_RE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.slack\.com$/i;

  // Pure function, no DOM: normalizes whatever the visitor typed into the
  // workspace field into a bare "<name>.slack.com" host, or null if it
  // does not look like a genuine Slack workspace host. Strips a leading
  // http(s):// scheme, any path/query/fragment, and trailing slashes;
  // accepts a bare name ("yourco") by appending ".slack.com"; rejects
  // anything else, so this never builds a link to an arbitrary domain.
  function normalizeWorkspaceDomain(raw) {
    var value = String(raw || "").trim();
    if (!value) return null;
    value = value.replace(/^https?:\/\//i, "");
    value = value.split(/[/?#]/)[0];
    value = value.replace(/\/+$/, "");
    if (!value) return null;
    if (!/\.slack\.com$/i.test(value) && /^[a-z0-9][a-z0-9-]*$/i.test(value)) {
      value = value + ".slack.com";
    }
    return SLACK_DOMAIN_RE.test(value) ? value.toLowerCase() : null;
  }

  function updateOpenAcornButton() {
    var button = byId("status-open-acorn-button");
    if (!button) return;
    var field = byId("status-workspace-url");
    var fallback = byId("status-open-acorn-fallback");
    var domain = normalizeWorkspaceDomain(field ? field.value : "");
    if (domain) {
      button.setAttribute("href", "https://" + domain + "/app_redirect?channel=acorn");
      button.setAttribute("target", "_blank");
      button.setAttribute("rel", "noopener");
      button.setAttribute("data-open-acorn-state", "active");
      button.removeAttribute("aria-disabled");
      button.classList.remove("status-open-acorn-inactive");
      button.classList.add("status-open-acorn-active");
      button.textContent = "Open #acorn";
      if (fallback) fallback.hidden = true;
    } else {
      button.setAttribute("href", "#status-workspace-url");
      button.removeAttribute("target");
      button.removeAttribute("rel");
      button.setAttribute("data-open-acorn-state", "inactive");
      button.setAttribute("aria-disabled", "true");
      button.classList.remove("status-open-acorn-active");
      button.classList.add("status-open-acorn-inactive");
      button.textContent = OPEN_ACORN_INACTIVE_LABEL;
      if (fallback) fallback.hidden = false;
    }
  }

  function wireOpenAcornButton() {
    var field = byId("status-workspace-url");
    if (field && !field.dataset.openAcornWired) {
      field.dataset.openAcornWired = "1";
      field.addEventListener("input", updateOpenAcornButton);
    }
    updateOpenAcornButton();
  }

  // Page-open beacon (issue #409, trigger (a)): the visitor's current
  // stage the moment /status loads, read from the same currentPhaseEl()
  // the chatbot panel already uses. Only fires with a token present (see
  // sendJourneyBeacon) -- a fresh visitor with no magic link yet has no
  // stage to attribute.
  function beaconPageOpen() {
    beaconStages(resolveStepIds(currentPhaseEl()));
  }

  // ---------------------------------------------------------------------
  // "Checks your server runs on its own" panel (issue #435's frontend
  // slice, founder ask 2026-07-24 night). Renders the result of PR #453's
  // nine box-side predicates (lib.onboarding_status.build_verification_
  // results, via /api/status's "verifications" array), server-rendered
  // in status_verifications.py in the honest default state ("Not yet
  // checked.") for every visitor. This code only ever OVERLAYS a real
  // result on a `data-verify-id` row already in the DOM -- it never
  // builds a row from scratch and never invents a state.
  //
  // THE HONESTY GUARANTEE: every sentence a visitor can read for a row
  // comes from VERIFY_STATE_COPY, loaded from the `status-verify-copy`
  // script tag lib.onboarding_status.VERIFICATION_STATE_COPY embeds. This
  // file never hardcodes the word "confirmed" (or "verified") anywhere --
  // grep it and see. So "confirmed" can only ever render for a row whose
  // resolved state is exactly "done", because that is the only state
  // whose copy contains that word (a pytest in tests/site_launch pins
  // that fact on the Python-side table directly).
  //
  // "stale" is the one state this file computes on its own, never sent by
  // the server: a row still "unchecked" after AWAIT_STUCK_MS (the same
  // 15-minute window/localStorage-timer pattern checkAwaitTimers() already
  // uses for other steps) escalates its own sentence to
  // VERIFY_STATE_COPY.stale, so a visitor is never left staring at a
  // "Not yet checked." that has quietly meant "stuck" for an hour.
  // ---------------------------------------------------------------------

  var VERIFY_STATE_COPY = {};
  var VERIFY_AWAIT_KEY_PREFIX = "acorn_status_verify_await_";

  function loadVerifyCopy() {
    var tag = byId("status-verify-copy");
    if (!tag) return;
    try {
      VERIFY_STATE_COPY = JSON.parse(tag.textContent) || {};
    } catch (e) {
      VERIFY_STATE_COPY = {};
    }
  }

  function allVerifyRows() {
    return document.querySelectorAll(".status-verify-row");
  }

  function verifyRow(stepId) {
    return document.querySelector(
      '.status-verify-row[data-verify-id="' + cssEscape(stepId) + '"]'
    );
  }

  function setVerifyAwait(stepId) {
    try {
      if (!window.localStorage.getItem(VERIFY_AWAIT_KEY_PREFIX + stepId)) {
        window.localStorage.setItem(VERIFY_AWAIT_KEY_PREFIX + stepId, String(Date.now()));
      }
    } catch (e) {
      /* private mode / storage disabled: the stale escalation simply never fires */
    }
  }

  function clearVerifyAwait(stepId) {
    try {
      window.localStorage.removeItem(VERIFY_AWAIT_KEY_PREFIX + stepId);
    } catch (e) {
      /* ignore */
    }
  }

  // Sets a row's marker/sentence/detail from ONE state, always through
  // VERIFY_STATE_COPY -- see the honesty-guarantee note above. `detail` is
  // shown only for "blocked" (the plain-language corrective the box
  // produced); every other state hides it, so a stale correction from a
  // previous fetch can never linger visible under a row that has since
  // turned unchecked again.
  function setVerifyRowState(rowEl, state, detail) {
    rowEl.setAttribute("data-verify-state", state);
    var marker = rowEl.querySelector(".status-verify-marker");
    var sentence = rowEl.querySelector(".status-verify-sentence");
    var detailEl = rowEl.querySelector(".status-verify-detail");
    if (marker) {
      // "optional" keeps the neutral ○ (ACR-496): it is a switch left
      // off, never a check that failed, so it never takes the "!" the
      // blocked state uses.
      marker.textContent = state === "done" ? "✓" : state === "blocked" ? "!" : "○";
    }
    if (sentence) {
      sentence.textContent = VERIFY_STATE_COPY[state] || "";
    }
    if (detailEl) {
      if (state === "blocked" && detail) {
        detailEl.textContent = detail;
        detailEl.hidden = false;
      } else {
        detailEl.textContent = "";
        detailEl.hidden = true;
      }
    }
  }

  // Applies /api/status's "verifications" array onto the already-rendered
  // rows. A row with no matching entry (an older page cached before a new
  // predicate shipped) is left exactly as server-rendered -- never blanked.
  function applyVerificationResults(list) {
    (list || []).forEach(function (item) {
      var rowEl = verifyRow(item.step_id);
      if (!rowEl) return;
      // "optional" (ACR-496) joins the server-resolvable states this
      // overlay will accept. It is deliberately NOT await-clocked: an
      // optional key nobody added is not something the visitor is
      // waiting on, so it must never escalate to the oak-brown "stale".
      var state =
        item.state === "done" || item.state === "blocked" || item.state === "optional"
          ? item.state
          : "unchecked";
      setVerifyRowState(rowEl, state, item.what_to_change);
      if (state === "unchecked") {
        setVerifyAwait(item.step_id);
      } else {
        clearVerifyAwait(item.step_id);
      }
    });
  }

  // ACR-496: the deferred optional-key rows. They are structurally
  // outside the phase rail (no .status-phase, no .status-substep, so
  // allPhases()/recomputeProgress()/refreshDisclosure() never see them),
  // which means applyBoxVerifiedState() cannot green them. This does,
  // and only that -- it touches no counter, no phase state, and no
  // beacon, because an optional key is not a stage of the journey.
  function applyOptionalKeyState(doneMap) {
    var rows = document.querySelectorAll("[data-optional-step-id]");
    Array.prototype.forEach.call(rows, function (el) {
      var stepId = el.getAttribute("data-optional-step-id");
      if (!stepId || !doneMap[stepId]) return;
      el.classList.add("status-optional-substep-is-done");
      var marker = el.querySelector(".status-optional-substep-marker");
      if (marker) marker.textContent = "✓";
    });
  }

  // Starts every row's await clock once, at page load, whenever a token
  // is present -- so "no result in a while" is measured from when the
  // visitor actually started waiting, not from whenever a particular
  // fetch happened to answer "unchecked". A row that has already resolved
  // (done/blocked) clears its own clock in applyVerificationResults above,
  // so this never re-arms a row that is already settled.
  function beginVerifyAwaitClocks() {
    Array.prototype.forEach.call(allVerifyRows(), function (rowEl) {
      // ACR-496: never start a clock on an optional row. Nobody is
      // waiting on a key nobody was asked for.
      if (rowEl.getAttribute("data-verify-optional") === "true") return;
      var stepId = rowEl.getAttribute("data-verify-id");
      if (stepId) setVerifyAwait(stepId);
    });
  }

  function checkVerifyStaleTimers() {
    Array.prototype.forEach.call(allVerifyRows(), function (rowEl) {
      // ACR-496: an optional row can never escalate to "stale". "stale"
      // renders in the same oak-brown as "blocked", and an absent
      // optional key must produce no red state anywhere on this page.
      if (rowEl.getAttribute("data-verify-optional") === "true") return;
      var state = rowEl.getAttribute("data-verify-state");
      if (state !== "unchecked" && state !== "stale") return;
      var stepId = rowEl.getAttribute("data-verify-id");
      var started = null;
      try {
        started = window.localStorage.getItem(VERIFY_AWAIT_KEY_PREFIX + stepId);
      } catch (e) {
        started = null;
      }
      if (started && Date.now() - parseInt(started, 10) > AWAIT_STUCK_MS) {
        setVerifyRowState(rowEl, "stale", null);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  loadFaqMap();
  loadVerifyCopy();
  wireCopyButtons();
  wireWorkspaceForm();
  wireAwsCheckbox();
  wireServerManualAdvance();
  wireConfirmButtons();
  wireKeyClaimButtons();
  wireAdminFork();
  wireAdminForkSentButtons();
  wireChatbotStub();
  wireChatOpeners();
  wireTawkOpenLinks();
  wireStartButton();
  wireOpenSecretsManagerCheckbox();
  wireOpenAcornButton();
  wirePhaseHeadToggles();
  recomputeProgress();
  refreshDisclosure();

  // Re-check the stuck timers on a slow interval so a returning visitor sees
  // the attention state without a reload.
  window.setInterval(checkAwaitTimers, 60 * 1000);
  window.setInterval(checkVerifyStaleTimers, 60 * 1000);

  var token = getToken();
  if (token) {
    beginVerifyAwaitClocks();
    beaconPageOpen();
    loadStatus(token);
  } else {
    showLinkForm();
  }
})();
