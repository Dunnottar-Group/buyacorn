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

// ACR-907: THE DEPOSIT IS ONE CHARGE, NOT A SUBSCRIPTION.
//
// Founder direction 2026-08-03: "someone needs to be able to reserve their
// Founding Member seat today with a $2500 payment. but that should not start
// the subscription until the subscription is manually started by a human."
// Clarified in the same exchange: "the $2500 IS the first month payment."
//
// So the ECONOMICS of the 2026-07-15 ruling are unchanged - $2,500 secures the
// seat and covers month one - and what changes is WHEN the Subscription object
// comes into existence. Subscription mode cannot express this: it starts the
// billing clock the instant the buyer pays. A one-time charge can, and the
// human starts the subscription after onboarding with the billing cycle
// anchored one period out so month one is never charged twice.
//
// DEPOSIT_AMOUNT IS ONE NUMBER FOR EVERY PAID PLAN. The founder said "$2500
// payment" with no annual carve-out, so an annual buyer also pays $2,500 today
// and the $25,000 annual rate is billed when a human starts their subscription.
// That is an ASSUMPTION, flagged as such on issue #907 and on the PR rather
// than buried here, because it is the one number a reader would otherwise
// assume was ruled.
export const DEPOSIT_AMOUNT = 250000;

// The founder-ruled plans. Source: cos/decisions/
// 2026-07-15_founding-member-commercial-pack.md. Retail is $5,000/mo; Founding
// is half of that for life while in good standing. Annual is 10 months paid.
// `interval` and `subscription_amount` are what a human uses to build the
// subscription later; they are deliberately NOT sent to Checkout, because
// sending them is what would start the clock.
export const CHECKOUT_PLANS = {
  monthly: {
    unit_amount: DEPOSIT_AMOUNT,
    interval: 'month',
    subscription_amount: 250000,
    product_name: 'Acorn Founding Member deposit',
    description: 'Secures one of the 25 Founding Member seats and covers your first month at the Founding rate of $2,500 per month, half of $5,000 retail. Your membership begins when Acorn activates it, and monthly billing starts after your first month.',
  },
  annual: {
    unit_amount: DEPOSIT_AMOUNT,
    interval: 'year',
    subscription_amount: 2500000,
    product_name: 'Acorn Founding Member deposit (annual plan)',
    description: 'Secures one of the 25 Founding Member seats and covers your first month. You chose the annual Founding rate of $25,000 per year, ten months paid with two months free, which is billed when Acorn activates your membership.',
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
    // ACR-907: one charge, no subscription. See DEPOSIT_AMOUNT above.
    mode: 'payment',
    // A Customer must exist for a human to attach the subscription to later.
    // In payment mode Stripe does NOT create one unless asked, and without it
    // the deposit is an orphan charge with no one to bill next month.
    customer_creation: 'always',
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
          // No `recurring` key. Its presence is what makes this a subscription
          // line item, and its absence is what keeps the billing clock stopped.
          unit_amount: plan.unit_amount,
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
      // ACR-907: everything a human needs to start the right subscription
      // later, carried on the payment itself so it survives without a lookup
      // in some other system. `subscription_started` is the flag that makes an
      // un-actioned paid deposit visible instead of silent.
      subscription_started: 'no',
      intended_interval: plan.interval,
      intended_subscription_amount: String(plan.subscription_amount),
      deposit_covers: 'month 1',
    },
    // NO `subscription_data`. In payment mode it is meaningless, and leaving it
    // here would read as if a subscription were being created.
    //
    // Saving the card is what makes "a human starts it later" humane. Without
    // it, activating a membership means going back to a buyer who already paid
    // and asking for card details a second time, which is the opposite of the
    // white-glove promise. Stripe shows the buyer the mandate text for this at
    // checkout, so it is disclosed, not silent.
    payment_intent_data: {
      setup_future_usage: 'off_session',
      description: `Founding Member deposit (${PLANS[v.plan]}) - covers month 1, subscription started manually`,
      metadata: {
        buyer_name: v.name,
        buyer_company: v.company,
        plan: v.plan,
        subscription_started: 'no',
      },
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
