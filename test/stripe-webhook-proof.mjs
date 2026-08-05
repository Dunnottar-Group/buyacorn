// ACR-833 proof: api/stripe-webhook.js. This endpoint is publicly reachable and
// announces "$2,500 paid" into #acorn, so the forgery tests are the point of
// this file, not a formality.
// Run: node test/stripe-webhook-proof.mjs
import crypto from 'node:crypto';
import handler, { verifyStripeSignature, parseSignatureHeader } from '../api/stripe-webhook.js';

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
const ENV_KEYS = ['STRIPE_WEBHOOK_SECRET', 'RESERVE_SLACK_BOT_TOKEN', 'CONTACT_SLACK_BOT_TOKEN', 'RESERVE_SLACK_CHANNEL', 'CONTACT_SLACK_CHANNEL', 'RESERVE_NOTIFY_USER_ID'];
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

const SECRET = 'whsec_test_secret';
const ENV = { STRIPE_WEBHOOK_SECRET: SECRET, RESERVE_SLACK_BOT_TOKEN: 'xoxb-test' };

function sign(raw, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}
function req(rawBody, header) {
  return { method: 'POST', rawBody, headers: { 'stripe-signature': header } };
}

const PAID = JSON.stringify({
  type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_live_abc', payment_status: 'paid', amount_total: 250000, currency: 'usd',
    customer_details: { email: 'dana@example.com', name: 'Dana Buyer' },
    metadata: { buyer_name: 'Dana Buyer', buyer_company: 'Chang Robotics', plan: 'monthly',
      plan_label: 'Founding Member, $2,500/mo (half of $5,000 retail, for life)', source_slug: 'johnrobb' },
  } },
});

let slackCall = null;
global.fetch = async (url, opts) => { slackCall = JSON.parse(opts.body); return { json: async () => ({ ok: true, ts: '1785.2' }) }; };

console.log('ACR-833 api/stripe-webhook.js proof');

// --- signature verification, in isolation ---
const now = 1785000000;
const raw = '{"a":1}';
const goodSig = crypto.createHmac('sha256', SECRET).update(`${now}.${raw}`, 'utf8').digest('hex');
ok('valid signature verifies', verifyStripeSignature(raw, `t=${now},v1=${goodSig}`, SECRET, now).ok);
ok('wrong secret is rejected', !verifyStripeSignature(raw, `t=${now},v1=${goodSig}`, 'whsec_other', now).ok);
ok('tampered body is rejected', !verifyStripeSignature('{"a":2}', `t=${now},v1=${goodSig}`, SECRET, now).ok);
ok('replay outside tolerance is rejected', !verifyStripeSignature(raw, `t=${now},v1=${goodSig}`, SECRET, now + 600).ok);
ok('replay just inside tolerance is accepted', verifyStripeSignature(raw, `t=${now},v1=${goodSig}`, SECRET, now + 299).ok);
ok('missing header rejected, with a real reason', !verifyStripeSignature(raw, '', SECRET, now).ok);
ok('header with no v1 rejected', !verifyStripeSignature(raw, `t=${now}`, SECRET, now).ok);
ok('non-numeric timestamp rejected', !verifyStripeSignature(raw, `t=abc,v1=${goodSig}`, SECRET, now).ok);
ok('short/garbage signature cannot crash timingSafeEqual', !verifyStripeSignature(raw, `t=${now},v1=ff`, SECRET, now).ok);
ok('multiple v1 sigs accepted during secret rotation',
  verifyStripeSignature(raw, `t=${now},v1=deadbeef,v1=${goodSig}`, SECRET, now).ok);
ok('signature header parser reads t and all v1s',
  parseSignatureHeader('t=1,v1=a,v1=b').t === '1' && parseSignatureHeader('t=1,v1=a,v1=b').v1.length === 2);

// --- the endpoint ---
let r = await call({ method: 'GET' }, ENV);
ok('GET -> 405', r.statusCode === 405 && r.headers.Allow === 'POST');

r = await call(req(PAID, sign(PAID)));
ok('no STRIPE_WEBHOOK_SECRET -> 503 fail-closed, nothing announced', r.statusCode === 503 && /not configured/.test(r.body.error));

// THE ATTACK: anyone can POST here. An unsigned or wrongly-signed "someone paid
// $2,500" must never reach #acorn.
slackCall = null;
r = await call(req(PAID, undefined), ENV);
ok('UNSIGNED forgery -> 400 and NOTHING posted to Slack', r.statusCode === 400 && slackCall === null, JSON.stringify(r.body));
slackCall = null;
r = await call(req(PAID, sign(PAID, 'whsec_attacker')), ENV);
ok('WRONG-SECRET forgery -> 400 and NOTHING posted', r.statusCode === 400 && slackCall === null);
slackCall = null;
const tampered = PAID.replace('250000', '1');
r = await call(req(tampered, sign(PAID)), ENV);
ok('TAMPERED amount -> 400 and NOTHING posted', r.statusCode === 400 && slackCall === null);
slackCall = null;
r = await call(req(PAID, sign(PAID, SECRET, Math.floor(Date.now() / 1000) - 3600)), ENV);
ok('REPLAYED old event -> 400 and NOTHING posted', r.statusCode === 400 && slackCall === null);

// --- verified, valid, paid ---
slackCall = null;
r = await call(req(PAID, sign(PAID)), ENV);
ok('verified paid session -> 200 handled+paid', r.statusCode === 200 && r.body.handled === true && r.body.paid === true);
ok('announces a PAID seat and tags the founder', slackCall && /FOUNDING MEMBER SEAT PAID/.test(slackCall.text) && /<@U0AU1SJGS92>/.test(slackCall.text));
ok('states the amount in dollars, from Stripe not from us', /\$2,500\.00 USD/.test(slackCall.text), slackCall && slackCall.text);
ok('carries buyer, company, plan, source', /Dana Buyer/.test(slackCall.text) && /Chang Robotics/.test(slackCall.text) && /\$2,500\/mo/.test(slackCall.text) && /johnrobb/.test(slackCall.text));
ok('says this one COUNTS toward the 25 seats', /COUNTS toward the 25 seats/.test(slackCall.text));

// --- completed but NOT settled must not be reported as a sale ---
const UNPAID = PAID.replace('"payment_status":"paid"', '"payment_status":"unpaid"');
slackCall = null;
r = await call(req(UNPAID, sign(UNPAID)), ENV);
ok('unsettled payment -> paid:false', r.statusCode === 200 && r.body.paid === false);
ok('unsettled is NOT announced as a sale', !/SEAT PAID/.test(slackCall.text) && /NOT yet settled/.test(slackCall.text));
ok('unsettled explicitly does NOT count', /Does NOT count yet/.test(slackCall.text));

// --- other event types ---
const OTHER = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
slackCall = null;
r = await call(req(OTHER, sign(OTHER)), ENV);
ok('unhandled event -> 200 handled:false (no Stripe retry storm)', r.statusCode === 200 && r.body.handled === false && slackCall === null);

// --- verified but malformed JSON ---
const BAD = 'not json';
r = await call(req(BAD, sign(BAD)), ENV);
ok('verified but unparseable body -> 400', r.statusCode === 400 && /not valid JSON/.test(r.body.error));

// --- Slack down: must still 200 so Stripe does not retry and re-announce ---
global.fetch = async () => { throw new Error('slack down'); };
r = await call(req(PAID, sign(PAID)), ENV);
ok('Slack failure -> still 200, but notified:false reported honestly',
  r.statusCode === 200 && r.body.notified === false && /network error/.test(r.body.notify_error));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
