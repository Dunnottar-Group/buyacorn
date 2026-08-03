// ACR-833: the Stripe webhook. This is the ONLY thing that proves payment.
//
// A browser landing on /reserve/paid proves the buyer's browser followed a
// redirect. It does not prove a card was charged: the URL can be visited
// directly, a session can be abandoned after redirect, and asynchronous payment
// methods settle later. Treating that redirect as proof would be the same class
// of error as claiming Slack delivery from an HTTP 200, which this codebase
// already refuses to do everywhere else. So the seat is announced as PAID here
// and nowhere else.
//
// SIGNATURE VERIFICATION IS MANDATORY AND DONE BY HAND. This endpoint is
// publicly reachable, and anyone who finds it could otherwise POST a fake
// "someone paid $2,500" event straight into #acorn. Stripe signs every webhook;
// we verify with node:crypto HMAC-SHA256 rather than pulling in the Stripe SDK,
// matching this repo's one-dependency, fetch-and-crypto house style.
//
// The scheme (Stripe's documented construction):
//   signed_payload = `${timestamp}.${raw_request_body}`
//   expected       = HMAC_SHA256(signed_payload, STRIPE_WEBHOOK_SECRET) as hex
//   compare        = timing-safe against every v1 signature in the header
// The timestamp is also checked against a tolerance window, because a valid
// signature replayed forever is still an attack.
//
// RAW BODY REQUIRED. The signature covers the exact bytes Stripe sent, so the
// body must NOT be parsed before verification. bodyParser is disabled below;
// re-enabling it silently breaks verification and every real event starts
// failing closed.

import crypto from 'node:crypto';
import { slackEscape, postToSlack, FOUNDER_ID } from './_reserve-lib.js';

export const config = { api: { bodyParser: false } };

// Stripe's default tolerance. Older events are rejected as replays.
const TOLERANCE_SECONDS = 300;

export async function readRawBody(req) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  for (const part of (header || '').split(',')) {
    const [k, val] = part.split('=');
    if (k === 't') out.t = val;
    else if (k === 'v1' && val) out.v1.push(val);
  }
  return out;
}

// Returns {ok:true} or {ok:false, reason}. Never throws on bad input, and never
// reports a reason it did not actually observe.
export function verifyStripeSignature(rawBody, header, secret, nowSeconds) {
  const { t, v1 } = parseSignatureHeader(header);
  if (!t || v1.length === 0) return { ok: false, reason: 'signature header is missing a timestamp or v1 signature' };
  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'signature timestamp is not a number' };
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'signature timestamp is outside the tolerance window' };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  // Compare against every provided v1: Stripe sends more than one during a
  // secret rotation. timingSafeEqual requires equal lengths, so guard first.
  const match = v1.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf8');
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
  return match ? { ok: true } : { ok: false, reason: 'signature did not match' };
}

function dollars(cents) {
  if (typeof cents !== 'number') return 'unknown amount';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed. Without the secret nothing can be verified, so nothing is
    // trusted and nothing is announced.
    return res.status(503).json({ ok: false, error: 'webhook is not configured on the server' });
  }

  const raw = await readRawBody(req);
  const verdict = verifyStripeSignature(
    raw,
    req.headers && (req.headers['stripe-signature'] || req.headers['Stripe-Signature']),
    secret,
    Math.floor(Date.now() / 1000),
  );
  if (!verdict.ok) {
    return res.status(400).json({ ok: false, error: `signature rejected: ${verdict.reason}` });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ ok: false, error: 'verified body was not valid JSON' });
  }

  // Acknowledge everything Stripe sends. Unhandled event types are a 200 with
  // handled:false, never an error: returning non-2xx makes Stripe retry an
  // event we were never going to act on.
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ ok: true, handled: false, type: event.type });
  }

  const session = (event.data && event.data.object) || {};
  const md = session.metadata || {};

  // Only announce a seat as paid when Stripe says the money is actually there.
  // A completed session whose payment is still processing is reported as such,
  // truthfully, rather than as a sale.
  const paid = session.payment_status === 'paid';

  const head = paid
    ? `:tada: <@${FOUNDER_ID()}> *FOUNDING MEMBER DEPOSIT PAID - ACTION REQUIRED*`
    : `:hourglass: <@${FOUNDER_ID()}> *Founding Member checkout completed, payment NOT yet settled*`;

  const lines = [
    head,
    `*Name:* ${slackEscape(md.buyer_name || session.customer_details?.name || 'not provided')}`,
    `*Email:* ${slackEscape(session.customer_details?.email || session.customer_email || 'not provided')}`,
    `*Company:* ${slackEscape(md.buyer_company || 'not provided')}`,
    `*Plan:* ${slackEscape(md.plan_label || md.plan || 'not recorded')}`,
    `*Amount:* ${dollars(session.amount_total)} ${String(session.currency || 'usd').toUpperCase()}`,
    `*Payment status:* ${slackEscape(session.payment_status || 'unknown')}`,
    `*Stripe session:* ${slackEscape(session.id || 'unknown')}`,
  ];
  if (md.source_slug) lines.push(`*Source:* ${slackEscape(md.source_slug)}`);
  if (md.notes) lines.push(`*Notes:* ${slackEscape(md.notes)}`);

  // ACR-907: the deposit does NOT start a subscription. A human does, after
  // onboarding. That makes this message the only thing standing between a paid
  // buyer and being silently forgotten, so it states the outstanding action
  // plainly and carries the Stripe customer id needed to act on it. Announcing
  // a payment without naming the work it creates is how a $2,500 buyer ends up
  // waiting on nobody.
  if (paid) {
    lines.push(
      `*Stripe customer:* ${slackEscape(session.customer || 'not created')}`,
      `*Subscription:* NOT STARTED. This deposit covers month 1 only.`,
      `*Their plan when you start it:* ${slackEscape(md.plan_label || md.plan || 'not recorded')}`,
      'ACTION: after onboarding, start their subscription in Stripe against the customer above, '
        + 'and anchor the first billing one period out so month 1 is not charged twice. '
        + 'Their card is already saved, so you do not need to ask them for it again.',
      'This one COUNTS toward the 25 seats. Money has moved, verified by Stripe signature.',
    );
  } else {
    lines.push('Does NOT count yet. Stripe has not settled this payment.');
  }

  const delivered = await postToSlack(lines.join('\n'));

  // Stripe retries on non-2xx. A failed Slack post must NOT cause a retry storm
  // that re-announces a seat, so this returns 200 and reports the delivery
  // failure in the body honestly rather than pretending it succeeded.
  return res.status(200).json({
    ok: true,
    handled: true,
    paid,
    notified: delivered.ok,
    notify_error: delivered.ok ? undefined : delivered.error,
  });
}
