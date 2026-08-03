// ACR-790: real transport for the Founding Member seat reservation form.
//
// WHY A RESERVATION AND NOT A CHECKOUT. Verified from disk 2026-08-03: there
// are no STRIPE*/MERCURY* keys on this stack, and zone_2/legal/
// llc-formation-2026-07.md has the LLC awaiting a Sunbiz examiner, with EIN ->
// Stripe -> Mercury still downstream of that approval. No card can be charged
// today. This endpoint therefore captures a COMMITMENT, never a payment, and
// the copy it backs says so plainly. When #64 clears, a deposit link is added
// to the same page; nothing here has to be rewritten.
//
// Modeled on api/alpha.js (ACR-769) and api/contact.js (ACR-751), both proven
// live in production 2026-08-03 03:5xZ. Same contract, deliberately:
//   - success is returned ONLY after Slack confirms delivery (never a silent
//     drop, never an invented reason for a failure)
//   - a 400 names every field that is missing, so the prospect is never left
//     guessing which box they missed
//   - 503 when the server has no token, 502 when delivery is not confirmed
//
// NO HONEYPOT. As in alpha.js, `company` is a REAL required field here (the
// buyer's company: a Founding seat is sold to a company, not a person, per the
// 2026-07-15 ruling that "25 seats" means 25 companies). It must never be
// treated as a bot trap.
//
// PLAN VALUES are constrained to the founder-ruled set. An unrecognised plan is
// rejected rather than passed through, so a tampered form can never post an
// invented price into #acorn and have it read as though Brian had agreed to it.
//
// Secrets: a Slack bot token must be set server-side as a Vercel env var --
// RESERVE_SLACK_BOT_TOKEN, falling back to CONTACT_SLACK_BOT_TOKEN so this
// works with the token /contact and /alpha already use. Never in client code
// or this repo.

import { PLANS, readJsonBody, validateBuyer as validate, slackEscape, FOUNDER_ID } from './_reserve-lib.js';

// ACR-833: MAX_*, readJsonBody, validate, slackEscape and the PLANS table moved
// to api/_reserve-lib.js so /api/checkout validates the identical form the
// identical way. Divergence between them would let a buyer pass one endpoint
// and be rejected by the other for the same input, at the moment they are
// trying to pay. Behaviour here is unchanged, proven by test/reserve-proof.mjs
// (30 assertions) passing untouched across this refactor.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: 'request body was not valid JSON' });
  }

  const v = validate(body);
  if (v.errors.length > 0) {
    return res.status(400).json({ ok: false, error: v.errors.join('; ') });
  }

  const token = process.env.RESERVE_SLACK_BOT_TOKEN || process.env.CONTACT_SLACK_BOT_TOKEN;
  const channel =
    process.env.RESERVE_SLACK_CHANNEL || process.env.CONTACT_SLACK_CHANNEL || 'C0ATRTVMCH1'; // HQ #acorn
  if (!token) {
    return res.status(503).json({
      ok: false,
      error: 'delivery channel is not configured on the server',
    });
  }

  // ACR-815: tag the founder. /reserve/thanks promises every buyer in writing that
  // "Brian reaches out to you personally", and without a mention this lands as an
  // ordinary channel message that can scroll past unseen. That is the #786 class: a
  // page states a commitment the mechanism behind it does not deliver, and here the
  // cost is a company committing to $2,500/mo.
  //
  // The id DEFAULTS in code on purpose. An env var that has to be set on Vercel would
  // fail silently in exactly the case that matters, and this must work with zero
  // configuration. The override exists so the destination can move without a deploy.
  //
  // Deliberately NOT applied to api/alpha.js: alpha applications are higher volume and
  // sit in Anna Leigh's follow-up lane. bin/loop_sentinel.py tags on NEW breaches only
  // for the same reason, to keep the mention meaningful. This is the same discipline.
  //
  // Not passed through slackEscape: this is a literal control token the handler owns,
  // never a buyer-supplied value.
  const founderId = FOUNDER_ID();

  // "Seat reservation", never "seat sold". Per the 2026-07-15 ruling the public
  // 25-seat counter reflects cleared payments only, and no money has moved
  // here. The message says so on its own line so a reservation can never be
  // miscounted as revenue by whoever reads it next.
  const lines = [
    `:handshake: <@${founderId}> *Founding Member seat reservation* (buyacorn.com /reserve)`,
    `*Name:* ${slackEscape(v.name)}`,
    `*Email:* ${slackEscape(v.email)}`,
    `*Company:* ${slackEscape(v.company)}`,
    `*Plan:* ${PLANS[v.plan]}`,
    `*Received:* ${new Date().toISOString()} (UTC)`,
    `*Acknowledged* -- Founding Member terms: yes | no payment taken today: yes`,
    '*NO MONEY HAS MOVED.* This is a held seat. It counts toward the 25-seat',
    'counter once a deposit clears, and stays uncounted until then.',
  ];
  if (v.slug) lines.push(`*Source:* ${slackEscape(v.slug)}`);
  if (v.notes) lines.push(`*Notes:* ${slackEscape(v.notes)}`);
  const text = lines.join('\n');

  let slack;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    slack = await resp.json();
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `delivery request failed: ${err && err.name === 'AbortError' ? 'timed out' : 'network error'}`,
    });
  }

  if (!slack || slack.ok !== true) {
    return res.status(502).json({
      ok: false,
      error: `delivery was not confirmed (${(slack && slack.error) || 'no response detail'})`,
    });
  }

  return res.status(200).json({ ok: true, ref: slack.ts });
}
