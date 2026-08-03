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
  'CONTACT_SLACK_BOT_TOKEN', 'RESERVE_SLACK_CHANNEL', 'CONTACT_SLACK_CHANNEL',
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
const KEY = { STRIPE_SECRET_KEY: 'sk_test_x', RESERVE_SLACK_BOT_TOKEN: 'xoxb-test' };

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
ok('monthly price is the ruled $2,500/month', CHECKOUT_PLANS.monthly.unit_amount === 250000 && CHECKOUT_PLANS.monthly.interval === 'month');
ok('annual price is the ruled $25,000/year', CHECKOUT_PLANS.annual.unit_amount === 2500000 && CHECKOUT_PLANS.annual.interval === 'year');
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
ok('subscription mode, per the ruled "2nd subscription payment"', b.get('mode') === 'subscription');
ok('charges the ruled $2,500 monthly', b.get('line_items[0][price_data][unit_amount]') === '250000' && b.get('line_items[0][price_data][recurring][interval]') === 'month');
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
ok('checkout-started notice does NOT claim a sale', slackCall && /NOT A SALE YET/.test(slackCall.text) && !/PAID/.test(slackCall.text));

// --- annual ---
stripeCall = null;
r = await call({ method: 'POST', body: { ...VALID, plan: 'annual' } }, KEY);
const ab = new URLSearchParams(stripeCall.body);
ok('annual charges the ruled $25,000/year', r.statusCode === 200 && ab.get('line_items[0][price_data][unit_amount]') === '2500000' && ab.get('line_items[0][price_data][recurring][interval]') === 'year');

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
