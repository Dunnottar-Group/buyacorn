// ACR-833: Stripe Checkout for the $2,500 Founding Member deposit.
//
// WHY SUBSCRIPTION MODE AND NOT A ONE-OFF CHARGE. The 2026-07-15 founder
// ruling says the deposit is "refundable up until the 2nd subscription
// payment", and that it "secures a Founding seat and covers month 1". The
// deposit IS month 1 of the subscription, so a Checkout Session in
// subscription mode expresses the ruled terms exactly: the first invoice is
// the deposit, the refund window closes when the second invoice is paid.
// A one-off payment would leave month 2 as an untracked manual step and would
// not match the words that were ruled.
//
// FLAG-GATED AND INERT. With no STRIPE_SECRET_KEY set, this endpoint returns
// 503 and /reserve keeps behaving exactly as it does today: a reservation
// posted to #acorn with no payment. Nothing about the live rail changes until
// Brian sets the key. /reserve's own copy is NOT flipped by this env var
// either: a page whose commercial claims change because a secret was deployed
// is a bad property, so the copy change is a separate reviewable PR.
//
// NO SDK, DELIBERATELY. This repo runs one dependency (astro) and calls vendor
// REST APIs with fetch (see reserve.js and contact.js against Slack). Stripe is
// called the same way. That keeps the dependency list and the supply-chain
// surface where they are, and Stripe's REST shape is stable and documented.
//
// AMOUNTS LIVE HERE, NOT IN THE STRIPE DASHBOARD. Inline price_data means the
// amount charged is the amount the page states, from one source of truth in
// this file. Referencing dashboard price IDs would let the page and the charge
// drift apart silently, which on a commercial page is the defect class that
// costs trust. If Stripe-managed products are wanted later for reporting, that
// is a deliberate change, not a default.
//
// THE AGREEMENT PROMISE IS LOAD-BEARING. /reserve tells every buyer: "a lawyer
// written membership agreement replaces them before any deposit is taken. You
// will see it before you pay anything." consent_collection[terms_of_service]
// is therefore REQUIRED on every session, so Stripe shows the agreement link
// and records acceptance before it will take a card. The URL behind it is set
// in the Stripe Dashboard, and the lawyer's document must be what lives there
// before payment is enabled.

import { PLANS, validateBuyer, slackEscape, readJsonBody, postToSlack } from './_reserve-lib.js';

// The founder-ruled prices, in cents. Source: cos/decisions/
// 2026-07-15_founding-member-commercial-pack.md. Retail is $5,000/mo; Founding
// is half of that for life while in good standing. Annual is 10 months paid.
export const CHECKOUT_PLANS = {
  monthly: {
    unit_amount: 250000,
    interval: 'month',
    product_name: 'Acorn Founding Member',
    description: 'Founding Member rate, $2,500 per month. Half of $5,000 retail. Your first payment is the deposit that secures your seat and covers month one.',
  },
  annual: {
    unit_amount: 2500000,
    interval: 'year',
    product_name: 'Acorn Founding Member (annual)',
    description: 'Founding Member annual rate, $25,000 per year. Ten months paid, two months free.',
  },
};

// Stripe's API is form-encoded with bracket notation for nested values
// (line_items[0][price_data][unit_amount]). Flatten a plain object into that
// shape rather than hand-writing the keys, so a nested value can never be
// silently dropped.
export function toStripeForm(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') toStripeForm(item, `${key}[${i}]`, out);
        else out.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === 'object') {
      toStripeForm(v, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

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

  const v = validateBuyer(body);
  if (v.errors.length > 0) {
    return res.status(400).json({ ok: false, error: v.errors.join('; ') });
  }

  // "undecided" is a real, ruled choice: hold a seat and talk to Brian. It has
  // no price and must never reach a card form. This is a 400 rather than a
  // silent fallback so the caller cannot quietly charge someone who chose to
  // decide later.
  if (!Object.prototype.hasOwnProperty.call(CHECKOUT_PLANS, v.plan)) {
    return res.status(400).json({
      ok: false,
      error: `the "${v.plan}" option does not take payment; it is a reservation`,
    });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    // Inert by default. The caller falls back to the reservation path, which is
    // exactly today's live behaviour.
    return res.status(503).json({ ok: false, error: 'payment is not enabled on the server' });
  }

  const plan = CHECKOUT_PLANS[v.plan];
  const origin = process.env.PUBLIC_SITE_ORIGIN || 'https://buyacorn.com';

  const payload = {
    mode: 'subscription',
    // Stripe appends the session id so the return page can identify the
    // session. The page still treats the webhook as the only proof of payment.
    success_url: `${origin}/reserve/paid?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/reserve`,
    customer_email: v.email,
    client_reference_id: `reserve-${Date.now()}`,
    allow_promotion_codes: 'true',
    // The founder ruling allows comped seats as a 100% discount code, so
    // promotion codes stay available at checkout.
    consent_collection: { terms_of_service: 'required' },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: plan.unit_amount,
          recurring: { interval: plan.interval },
          product_data: { name: plan.product_name, description: plan.description },
        },
      },
    ],
    // Metadata rides through to the webhook so the #acorn notification can name
    // the buyer without a second API call, and so a paid seat can be matched
    // back to its reservation.
    metadata: {
      buyer_name: v.name,
      buyer_company: v.company,
      plan: v.plan,
      plan_label: PLANS[v.plan],
      source_slug: v.slug || '',
      notes: v.notes || '',
    },
    subscription_data: {
      metadata: { buyer_name: v.name, buyer_company: v.company, plan: v.plan },
    },
  };

  let stripe;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: toStripeForm(payload).toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    stripe = await resp.json();
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `payment session request failed: ${err && err.name === 'AbortError' ? 'timed out' : 'network error'}`,
    });
  }

  // Never invent a reason. Stripe's own error message is quoted when it gives
  // one, and the absence of a URL is reported as exactly that.
  if (stripe && stripe.error) {
    return res.status(502).json({
      ok: false,
      error: `payment session was refused (${stripe.error.message || stripe.error.type || 'no detail'})`,
    });
  }
  if (!stripe || !stripe.url) {
    return res.status(502).json({ ok: false, error: 'payment session was not created (no checkout url returned)' });
  }

  // Tell HQ a buyer has REACHED checkout. This is deliberately not a sale, and
  // says so: a created session proves intent, and only the webhook proves
  // payment. Best-effort, because failing to notify must never block a buyer
  // who is trying to pay.
  try {
    await postToSlack([
      `:credit_card: *Checkout started* (buyacorn.com /reserve)`,
      `*Name:* ${slackEscape(v.name)}`,
      `*Company:* ${slackEscape(v.company)}`,
      `*Plan:* ${PLANS[v.plan]}`,
      `NOT A SALE YET. This says a card form was opened. Payment is confirmed`,
      `only by the Stripe webhook, which posts separately.`,
    ].join('\n'));
  } catch {
    // swallowed on purpose, see above
  }

  return res.status(200).json({ ok: true, url: stripe.url, session_id: stripe.id });
}
