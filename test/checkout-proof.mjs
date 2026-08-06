// ACR-833 proof: api/checkout.js across every branch, with a mocked req/res
// and a mocked global.fetch (no real Stripe or Slack call).
// Run: node test/checkout-proof.mjs
import handler, { toStripeForm, CHECKOUT_PLANS } from '../api/checkout.js';

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
// Every env var either endpoint reads must be listed. A missing name does not
// fail loudly: it leaks the previous test's value into the next one and the
// suite stays green while testing the wrong configuration (the lesson from
// ACR-815's RESERVE_NOTIFY_USER_ID leak).
const ENV_KEYS = [
  'STRIPE_SECRET_KEY', 'PUBLIC_SITE_ORIGIN', 'RESERVE_SLACK_BOT_TOKEN',
  'CONTACT_SLACK_BOT_TOKEN', 'SLACK_CHECKOUT_CHANNEL',
  'RESERVE_NOTIFY_USER_ID',
];
async function call(req, env = {}) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const res = mockRes();
  // A handler that THROWS must not abort the suite and must not skip the env
  // restore below. Both happened: removing checkout's plan guard produced a
  // TypeError that killed the run with 20 assertions never executed, and left
  // the injected env vars set for whatever ran next. A throw is now recorded as
  // a 500 so the assertion that cares fails precisely and everything after it
  // still runs.
  try {
    await handler(req, res);
  } catch (err) {
    res.statusCode = 500;
    res.body = { ok: false, error: `handler threw: ${err && err.message}` };
    res.threw = err;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return res;
}
let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

const VALID = {
  name: 'Dana Buyer', email: 'dana@example.com', company: 'Chang Robotics',
  plan: 'monthly', notes: 'Met Brian at JVC', source_slug: 'johnrobb',
  terms_ack: true, no_charge_ack: true,
};
const KEY = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  RESERVE_SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_CHECKOUT_CHANNEL: 'C-CHECKOUT',
};

let stripeCall = null, slackCall = null, stripeReply = { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
global.fetch = async (url, opts) => {
  if (String(url).includes('api.stripe.com')) {
    stripeCall = { url: String(url), body: opts.body, headers: opts.headers };
    return { json: async () => stripeReply };
  }
  slackCall = JSON.parse(opts.body);
  return { json: async () => ({ ok: true, ts: '1785.1' }) };
};

console.log('ACR-833 api/checkout.js proof');

// --- the form encoder, which everything else depends on being right ---
const enc = toStripeForm({ mode: 'subscription', line_items: [{ quantity: 1, price_data: { unit_amount: 250000, recurring: { interval: 'month' } } }] });
ok('encoder flattens nested objects to Stripe bracket notation',
  enc.get('line_items[0][price_data][recurring][interval]') === 'month'
  && enc.get('line_items[0][price_data][unit_amount]') === '250000'
  && enc.get('line_items[0][quantity]') === '1', enc.toString());
ok('encoder drops null/undefined rather than sending "null"',
  !toStripeForm({ a: null, b: undefined, c: 'x' }).has('a') && !toStripeForm({ a: null, b: undefined, c: 'x' }).has('b'));

// --- the ruled prices ---
// ACR-907: `unit_amount` is now the DEPOSIT charged today (one number for every
// paid plan). `subscription_amount` + `interval` describe the subscription a
// human starts later and are deliberately never sent to Checkout.
ok('monthly deposit is $2,500 today, subscription is $2,500/month later',
  CHECKOUT_PLANS.monthly.unit_amount === 250000
  && CHECKOUT_PLANS.monthly.subscription_amount === 250000
  && CHECKOUT_PLANS.monthly.interval === 'month');
ok('annual deposit is ALSO $2,500 today, subscription is $25,000/year later',
  CHECKOUT_PLANS.annual.unit_amount === 250000
  && CHECKOUT_PLANS.annual.subscription_amount === 2500000
  && CHECKOUT_PLANS.annual.interval === 'year');
ok('every paid plan charges the SAME deposit today',
  new Set(Object.values(CHECKOUT_PLANS).map((p) => p.unit_amount)).size === 1);
ok('the ruled subscription prices survive unchanged for whoever starts them',
  CHECKOUT_PLANS.monthly.subscription_amount === 250000 && CHECKOUT_PLANS.annual.subscription_amount === 2500000);
ok('there is no priced "undecided" plan', !('undecided' in CHECKOUT_PLANS));

// --- method + body ---
let r = await call({ method: 'GET' });
ok('GET -> 405 with Allow: POST', r.statusCode === 405 && r.headers.Allow === 'POST');
r = await call({ method: 'POST', body: '{not json' });
ok('invalid JSON -> 400', r.statusCode === 400 && /valid JSON/.test(r.body.error));

// --- validation is the SHARED contract with /api/reserve ---
r = await call({ method: 'POST', body: {} }, KEY);
ok('empty body -> 400 naming every missing field',
  r.statusCode === 400 && /name is required/.test(r.body.error) && /email is required/.test(r.body.error)
  && /company is required/.test(r.body.error) && /plan choice is required/.test(r.body.error)
  && /terms must be acknowledged/.test(r.body.error), JSON.stringify(r.body));
r = await call({ method: 'POST', body: { ...VALID, terms_ack: false } }, KEY);
ok('terms not acknowledged -> 400, no session created', r.statusCode === 400 && /terms must be acknowledged/.test(r.body.error));

// --- "undecided" must never reach a card form ---
r = await call({ method: 'POST', body: { ...VALID, plan: 'undecided' } }, KEY);
ok('undecided -> 400, never charged, told it is a reservation',
  r.statusCode === 400 && /does not take payment/.test(r.body.error), JSON.stringify(r.body));

// --- inert without a key: this is what protects the live reservation rail ---
r = await call({ method: 'POST', body: VALID });
ok('no STRIPE_SECRET_KEY -> 503 inert, caller falls back to reservation',
  r.statusCode === 503 && /not enabled/.test(r.body.error));

// --- the happy path ---
stripeCall = null; slackCall = null;
r = await call({ method: 'POST', body: VALID }, KEY);
ok('valid monthly -> 200 with the Stripe checkout url', r.statusCode === 200 && r.body.ok === true && /checkout.stripe.com/.test(r.body.url));
const b = new URLSearchParams(stripeCall.body);
// ACR-907: one charge, no subscription. The founder ruled the deposit must not
// start the billing clock; a human does that after onboarding.
ok('payment mode, NOT subscription (ACR-907: deposit must not start the clock)', b.get('mode') === 'payment');
ok('charges the ruled $2,500 deposit', b.get('line_items[0][price_data][unit_amount]') === '250000');
// The single most important negative in this file. A `recurring` key anywhere
// turns the deposit back into a subscription and starts billing on the spot,
// which is precisely what ACR-907 exists to prevent. Asserted over the WHOLE
// encoded body, not one known key, so a rename or a nested reintroduction
// cannot slip past.
ok('NO recurring key anywhere in the Stripe payload', ![...b.keys()].some((k) => /recurring/.test(k)));
ok('NO subscription_data anywhere in the Stripe payload', ![...b.keys()].some((k) => /subscription_data/.test(k)));
// Without a Customer the deposit is an orphan charge and there is nobody to
// attach next month's subscription to.
ok('a Stripe Customer is always created (a human needs someone to bill later)', b.get('customer_creation') === 'always');
// Without the saved card, activating a membership means going back to a buyer
// who already paid and asking for their card a second time.
ok('card saved off_session so a human can start the sub without re-asking',
  b.get('payment_intent_data[setup_future_usage]') === 'off_session');
ok('metadata flags the subscription as NOT started', b.get('metadata[subscription_started]') === 'no');
ok('metadata carries the intended monthly subscription amount for whoever starts it',
  b.get('metadata[intended_subscription_amount]') === '250000' && b.get('metadata[intended_interval]') === 'month');
ok('currency is usd', b.get('line_items[0][price_data][currency]') === 'usd');
ok('terms-of-service consent REQUIRED (the page promises the agreement first)', b.get('consent_collection[terms_of_service]') === 'required');
ok('buyer email prefilled', b.get('customer_email') === 'dana@example.com');
ok('metadata carries name/company/plan/source for the webhook',
  b.get('metadata[buyer_name]') === 'Dana Buyer' && b.get('metadata[buyer_company]') === 'Chang Robotics'
  && b.get('metadata[plan]') === 'monthly' && b.get('metadata[source_slug]') === 'johnrobb');
ok('success_url returns to /reserve/paid with the session id', /\/reserve\/paid\?session_id=\{CHECKOUT_SESSION_ID\}/.test(b.get('success_url')));
ok('cancel_url returns to /reserve', /\/reserve$/.test(b.get('cancel_url')));
ok('promotion codes allowed (ruling permits comped seats as a 100% code)', b.get('allow_promotion_codes') === 'true');
ok('secret key sent as bearer, never in the body', /^Bearer sk_test_x$/.test(stripeCall.headers.Authorization) && !/sk_test_x/.test(stripeCall.body));

// --- the #acorn line must not claim a sale ---
ok('checkout-started notice posts to SLACK_CHECKOUT_CHANNEL and does NOT claim a sale',
  slackCall && slackCall.channel === 'C-CHECKOUT' && /NOT A SALE YET/.test(slackCall.text) && !/PAID/.test(slackCall.text));

// --- annual ---
stripeCall = null;
r = await call({ method: 'POST', body: { ...VALID, plan: 'annual' } }, KEY);
const ab = new URLSearchParams(stripeCall.body);
// ACR-907 ASSUMPTION, flagged on the issue and the PR rather than buried: the
// founder said "$2500 payment" with no annual carve-out, so an annual buyer
// also pays $2,500 today and the $25,000 is billed when a human starts their
// subscription. If that is wrong, THIS assertion is the one that changes.
ok('annual ALSO charges the $2,500 deposit today, not $25,000',
  r.statusCode === 200 && ab.get('line_items[0][price_data][unit_amount]') === '250000');
ok('annual carries the $25,000/year intent for whoever starts the subscription',
  ab.get('metadata[intended_subscription_amount]') === '2500000' && ab.get('metadata[intended_interval]') === 'year');
ok('annual has no recurring key either', ![...ab.keys()].some((k) => /recurring/.test(k)));

// --- origin override ---
stripeCall = null;
r = await call({ method: 'POST', body: VALID }, { ...KEY, PUBLIC_SITE_ORIGIN: 'https://staging.example' });
ok('site origin overridable for staging', /^https:\/\/staging\.example\//.test(new URLSearchParams(stripeCall.body).get('success_url')));

// --- failure paths: never a false success ---
stripeReply = { error: { message: 'No such price', type: 'invalid_request_error' } };
r = await call({ method: 'POST', body: VALID }, KEY);
ok('Stripe error -> 502 quoting Stripe, never invented', r.statusCode === 502 && /No such price/.test(r.body.error));

stripeReply = { id: 'cs_x' }; // no url
r = await call({ method: 'POST', body: VALID }, KEY);
ok('no checkout url -> 502, reported as exactly that', r.statusCode === 502 && /no checkout url/.test(r.body.error));

stripeReply = { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
const good = global.fetch;
global.fetch = async (url) => { if (String(url).includes('stripe')) { const e = new Error('t'); e.name = 'AbortError'; throw e; } return { json: async () => ({ ok: true }) }; };
r = await call({ method: 'POST', body: VALID }, KEY);
ok('Stripe timeout -> 502 named as a timeout', r.statusCode === 502 && /timed out/.test(r.body.error));
global.fetch = good;

// A Slack outage must never block a buyer who is trying to pay.
global.fetch = async (url, opts) => {
  if (String(url).includes('api.stripe.com')) return { json: async () => stripeReply };
  throw new Error('slack down');
};
r = await call({ method: 'POST', body: VALID }, KEY);
ok('Slack failure does NOT block checkout', r.statusCode === 200 && /checkout.stripe.com/.test(r.body.url));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
