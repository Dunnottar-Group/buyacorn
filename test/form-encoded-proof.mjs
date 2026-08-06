// ACR-829 proof (fixes #829): a no-JS submit must POST and be RECORDED, and
// the JSON/fetch path must be unchanged.
// Run: node test/form-encoded-proof.mjs
//
// What #829 was
// -------------
// #825 and #827 removed `action="mailto:..."` from every application form and
// left the tag with no `action` and no `method`. Per the HTML Standard both
// have defaults: `method` -> GET, `action` -> the document's own URL. So the
// submit did not stop leaking, it changed venue. Reproduced in a real browser
// on production 2026-08-03:
//
//   form.hasAttribute('method') -> false      form.method -> "get"
//   form.hasAttribute('action') -> false      form.action -> "https://buyacorn.com/alpha"
//
//   after HTMLFormElement.prototype.submit.call(form) -- the NATIVE submit,
//   which does not fire the submit event and so is not intercepted by the
//   page's preventDefault() handler, i.e. exactly what a JS-disabled browser
//   does -- the address bar read:
//
//   https://buyacorn.com/alpha?name=NOJS+Repro&email=acr829-repro%40example.com
//     &company=Repro+LLC&...&eula_accepted=on&auto_update_ack=on&data_share_tier3_ack=on
//
//   and curl of that exact URL returned HTTP 200 through the Vercel edge with
//   the query intact. Browser history, access logs, and the Referer header on
//   the next outbound click.
//
// Why the endpoints changed too
// -----------------------------
// `method="POST"` alone stops the leak and a static host answers 405, so the
// no-JS visitor would stop leaking AND stop being recorded. Trading a privacy
// defect for a lost applicant is not a fix. So the forms point at their own
// live endpoints and the endpoints speak `application/x-www-form-urlencoded`
// as well as JSON.
//
// The load-bearing claim this file exists to prove is the SECOND one: that the
// JSON path did not change. Every JSON assertion below is the behaviour that
// shipped before this PR, re-asserted against the new code.
//
// No network: global.fetch is mocked, no real Slack call is made.
import alphaHandler from '../api/alpha.js';
import waitlistHandler from '../api/waitlist.js';

// Every env var BOTH handlers read. A short list does not fail loudly: an
// override set by one case leaks into every later case and the run stays green
// while testing the wrong configuration (found live in the ACR-815 harness,
// 2026-08-03). Keep in sync with api/alpha.js and api/waitlist.js.
const HANDLER_ENV = [
  'ALPHA_SLACK_BOT_TOKEN',
  'ALPHA_SLACK_CHANNEL',
  'WAITLIST_SLACK_BOT_TOKEN',
  'WAITLIST_SLACK_CHANNEL',
  'CONTACT_SLACK_BOT_TOKEN',
  'CONTACT_SLACK_CHANNEL',
];

// Records everything a real res can carry, INCLUDING end() and the raw body.
// The pre-existing harnesses only implement json(), so a handler that answers
// with a redirect or an HTML page would look like it answered with nothing.
function mockRes() {
  return {
    statusCode: null, body: null, raw: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end(payload) { this.raw = payload === undefined ? '' : String(payload); return this; },
  };
}

async function call(handler, req, env = {}) {
  const saved = {};
  for (const k of HANDLER_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const res = mockRes();
  await handler(req, res);
  for (const k of HANDLER_ENV) {
    delete process.env[k];
    if (saved[k] !== undefined) process.env[k] = saved[k];
  }
  return res;
}

const formReq = (bodyString, extraHeaders = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
  body: bodyString,
});
const jsonReq = (obj) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: obj,
});

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

let lastPost = null;
const fetchOk = async (url, opts) => {
  lastPost = JSON.parse(opts.body);
  lastPost.__url = url;
  return { json: async () => ({ ok: true, ts: '1785.1234' }) };
};
const fetchSlackError = async () => ({ json: async () => ({ ok: false, error: 'channel_not_found' }) });
const fetchNetworkDown = async () => { throw new Error('boom'); };

const TOKEN_ENV = { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' };

console.log('ACR-829 form-encoded (no-JS) proof\n');

// =====================================================================
// /api/alpha
// =====================================================================
console.log('api/alpha.js -- FORM-ENCODED path (the no-JS applicant)');
global.fetch = fetchOk;

// Exactly the body a browser builds from public/alpha/index.html with every
// field filled and all three consent boxes checked. Checkboxes post "on".
const ALPHA_FORM_BODY =
  'name=Jane+Doe&email=jane%40example.com&company=Doe+LLC' +
  '&referral_text=Brian&source_slug=' +
  '&eula_accepted=on&auto_update_ack=on&data_share_tier3_ack=on';

lastPost = null;
let r = await call(alphaHandler, formReq(ALPHA_FORM_BODY), TOKEN_ENV);
ok('form submit -> 303 See Other (not 302: a refresh cannot re-POST)', r.statusCode === 303, `got ${r.statusCode}`);
ok('form submit -> Location: /alpha/thanks, the same page the JS path uses',
  r.headers.Location === '/alpha/thanks', JSON.stringify(r.headers));
ok('form submit -> no JSON body handed to a human', r.body === null);
ok('form submit was actually DELIVERED, not merely not-leaked', lastPost !== null);
ok('delivered message carries the applicant name', lastPost && lastPost.text.includes('Jane Doe'));
ok('delivered message carries the applicant email', lastPost && lastPost.text.includes('jane@example.com'));
ok('delivered message carries the applicant company', lastPost && lastPost.text.includes('Doe LLC'));
ok('checkbox "on" is recorded as consent GIVEN',
  lastPost && /EULA: yes \| auto-update: yes \| tier-3 telemetry: yes/.test(lastPost.text), lastPost && lastPost.text);

// An unchecked checkbox is ABSENT from the body. It must read as a refusal,
// never be assumed, and the applicant must be told which one.
r = await call(alphaHandler, formReq(
  'name=Jane+Doe&email=jane%40example.com&company=Doe+LLC&eula_accepted=on&auto_update_ack=on'
), TOKEN_ENV);
ok('an UNCHECKED consent box is a refusal, not an assumed yes', r.statusCode === 400, `got ${r.statusCode}`);
ok('refusal answers HTML, not raw JSON, to a human',
  (r.headers['Content-Type'] || '').startsWith('text/html'), JSON.stringify(r.headers));
ok('refusal names the REAL missing consent, never an invented reason',
  r.raw.includes('the tier-3 telemetry acknowledgement is required'), r.raw);
ok('refusal states plainly that nothing was saved', r.raw.includes('Nothing was saved'));
ok('refusal offers a route back', r.raw.includes('/alpha#apply'));

// An explicitly negative value must not be read as "non-empty, therefore yes".
r = await call(alphaHandler, formReq(
  'name=Jane+Doe&email=jane%40example.com&company=Doe+LLC' +
  '&eula_accepted=false&auto_update_ack=on&data_share_tier3_ack=on'
), TOKEN_ENV);
ok('eula_accepted=false is honoured as a NO', r.statusCode === 400 && r.raw.includes('the EULA must be accepted'), r.raw);

// CRITIC FINDING 1 (adversarial pass on this PR): the consent decoder was a
// DENYLIST -- anything present that was not one of a few English negatives
// recorded consent as GIVEN. These are the exact inputs the critic supplied.
for (const forged of ['I+do+not+agree', 'nope', 'null', 'undefined', 'x']) {
  r = await call(alphaHandler, formReq(
    `name=A&email=a%40b.com&company=C&eula_accepted=${forged}` +
    '&auto_update_ack=on&data_share_tier3_ack=on'
  ), TOKEN_ENV);
  ok(`eula_accepted=${forged} is NOT consent (allowlist, not denylist)`,
    r.statusCode === 400 && r.raw.includes('the EULA must be accepted'), `got ${r.statusCode}`);
}
// A repeated key arriving pre-parsed as an ARRAY used to stringify to
// "false,on" and be read as a value in its own right.
r = await call(alphaHandler, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: { name: 'A', email: 'a@b.com', company: 'C',
          eula_accepted: ['false', 'on'], auto_update_ack: 'on', data_share_tier3_ack: 'on' },
}, TOKEN_ENV);
ok('a pre-parsed ARRAY consent value applies last-wins, not string concatenation',
  r.statusCode === 303, `got ${r.statusCode}`);
r = await call(alphaHandler, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: { name: 'A', email: 'a@b.com', company: 'C',
          eula_accepted: ['on', 'false'], auto_update_ack: 'on', data_share_tier3_ack: 'on' },
}, TOKEN_ENV);
ok('an array ending in a negative is a refusal (fails CLOSED)',
  r.statusCode === 400 && r.raw.includes('the EULA must be accepted'), `got ${r.statusCode}`);

// CRITIC FINDING 2: the error page hard-coded /alpha#apply, so a no-JS
// applicant from /tre who mistyped their email retried on a page whose hidden
// source_slug is empty and lost the referral credit.
r = await call(alphaHandler, formReq(
  'name=A&email=not-an-email&company=C&source_slug=tre' +
  '&eula_accepted=on&auto_update_ack=on&data_share_tier3_ack=on'
), TOKEN_ENV);
ok('the retry link keeps the referral page (/tre), not the generic /alpha',
  r.raw.includes('href="/tre#apply"'), r.raw);
// ...but a slug is applicant-supplied, so it must never build a hostile link.
for (const [hostile, why] of [
  ['https%3A%2F%2Fevil.example', 'absolute URL'],
  ['%2F%2Fevil.example', 'protocol-relative URL'],
  ['..%2F..%2Fetc', 'traversal'],
  ['a%22%3E%3Cscript%3E', 'markup injection'],
]) {
  r = await call(alphaHandler, formReq(
    `name=A&email=not-an-email&company=C&source_slug=${hostile}` +
    '&eula_accepted=on&auto_update_ack=on&data_share_tier3_ack=on'
  ), TOKEN_ENV);
  ok(`a hostile source_slug (${why}) falls back to /alpha#apply`,
    r.raw.includes('href="/alpha#apply"') && !r.raw.includes('evil.example'), r.raw);
}

// CRITIC FINDING 4: the previous escape assertion was VACUOUS. validate() only
// ever emits fixed strings, so no attacker byte reached the message slot and
// the assertion stayed green whether htmlEscape worked or was deleted. This is
// the reachable path where NON-fixed text does reach it: Slack's own error
// field, echoed into the 502 page.
global.fetch = async () => ({ json: async () => ({ ok: false, error: '<img src=x onerror=alert(1)>' }) });
r = await call(alphaHandler, formReq(ALPHA_FORM_BODY), TOKEN_ENV);
ok('an upstream error containing markup is ESCAPED, not rendered',
  r.statusCode === 502
  && r.raw.includes('&lt;img src=x onerror=alert(1)&gt;')
  && !r.raw.includes('<img src=x'), r.raw);
global.fetch = fetchOk;

r = await call(alphaHandler, formReq('name=&email=&company=&eula_accepted=on&auto_update_ack=on&data_share_tier3_ack=on'), TOKEN_ENV);
ok('a validation failure answers 400 HTML', r.statusCode === 400 && r.raw.includes('name is required'));

// Real failure states must reach the human as themselves.
r = await call(alphaHandler, formReq(ALPHA_FORM_BODY), {});
ok('no token -> 503 HTML naming the real cause', r.statusCode === 503
  && r.raw.includes('delivery channel is not configured'), r.raw);
global.fetch = fetchSlackError;
r = await call(alphaHandler, formReq(ALPHA_FORM_BODY), TOKEN_ENV);
ok('Slack refused -> 502 HTML carrying SLACK\'s own error code', r.statusCode === 502
  && r.raw.includes('channel_not_found'), r.raw);
global.fetch = fetchNetworkDown;
r = await call(alphaHandler, formReq(ALPHA_FORM_BODY), TOKEN_ENV);
ok('network down -> 502 HTML, cause stated not invented', r.statusCode === 502
  && r.raw.includes('delivery request failed'), r.raw);
global.fetch = fetchOk;

// Content-Type variants a real browser or proxy can send.
r = await call(alphaHandler, formReq(ALPHA_FORM_BODY,
  { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }), TOKEN_ENV);
ok('charset parameter on the content-type still takes the form path', r.statusCode === 303);
r = await call(alphaHandler, formReq(ALPHA_FORM_BODY,
  { 'content-type': 'Application/X-WWW-Form-Urlencoded' }), TOKEN_ENV);
ok('content-type matching is case-insensitive', r.statusCode === 303);

// Vercel's Node runtime may hand the handler an already-parsed object.
r = await call(alphaHandler, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: { name: 'Jane Doe', email: 'jane@example.com', company: 'Doe LLC',
          eula_accepted: 'on', auto_update_ack: 'on', data_share_tier3_ack: 'on' },
}, TOKEN_ENV);
ok('a pre-parsed form body (Vercel runtime) works too', r.statusCode === 303, `got ${r.statusCode}`);

console.log('\napi/alpha.js -- JSON path MUST BE UNCHANGED');
const ALPHA_JSON = {
  name: 'Jane Doe', email: 'jane@example.com', company: 'Doe LLC',
  referral_text: 'Brian', source_slug: null,
  eula_accepted: true, auto_update_ack: true, data_share_tier3_ack: true,
};
lastPost = null;
r = await call(alphaHandler, jsonReq(ALPHA_JSON), TOKEN_ENV);
ok('JSON success -> 200 (NOT a redirect)', r.statusCode === 200, `got ${r.statusCode}`);
ok('JSON success -> {ok:true, ref:<slack ts>}',
  r.body && r.body.ok === true && r.body.ref === '1785.1234', JSON.stringify(r.body));
ok('JSON success sends no Location header', r.headers.Location === undefined);
ok('JSON success writes no HTML body', r.raw === null);
ok('JSON path still delivers to Slack', lastPost !== null && lastPost.text.includes('jane@example.com'));

r = await call(alphaHandler, jsonReq({ ...ALPHA_JSON, eula_accepted: false }), TOKEN_ENV);
ok('JSON validation failure -> 400 JSON, still not HTML',
  r.statusCode === 400 && r.body && r.body.ok === false && r.raw === null, JSON.stringify(r.body));
ok('JSON validation failure keeps its exact error text',
  r.body.error.includes('the EULA must be accepted'), r.body.error);

// A JSON body that is NOT a real boolean must still be a refusal. This is the
// assertion that would catch the form-decoding leaking into the JSON path.
r = await call(alphaHandler, jsonReq({ ...ALPHA_JSON, eula_accepted: 'on' }), TOKEN_ENV);
ok('JSON eula_accepted:"on" is STILL not consent (form decoding did not leak in)',
  r.statusCode === 400 && r.body.error.includes('the EULA must be accepted'), JSON.stringify(r.body));

r = await call(alphaHandler, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }, TOKEN_ENV);
ok('malformed JSON -> 400 JSON with the original message',
  r.statusCode === 400 && r.body && r.body.error === 'request body was not valid JSON', JSON.stringify(r.body));

r = await call(alphaHandler, { method: 'GET', headers: {} }, TOKEN_ENV);
ok('GET -> 405 JSON with Allow: POST (unchanged)',
  r.statusCode === 405 && r.headers.Allow === 'POST' && r.body.error === 'method not allowed');

// No content-type at all must NOT be treated as a form: JSON stays the default.
r = await call(alphaHandler, { method: 'POST', headers: {}, body: ALPHA_JSON }, TOKEN_ENV);
ok('no content-type -> JSON path (the default did not move)',
  r.statusCode === 200 && r.body && r.body.ok === true, `${r.statusCode} ${JSON.stringify(r.body)}`);

// =====================================================================
// /api/waitlist
// =====================================================================
console.log('\napi/waitlist.js -- FORM-ENCODED path (the no-JS visitor)');
const WAITLIST_FORM_BODY =
  'name=Sam+Visitor&email=sam%40example.com&company=Sam+Co&referral_text=Brian&source_slug=&website=';

lastPost = null;
r = await call(waitlistHandler, formReq(WAITLIST_FORM_BODY), TOKEN_ENV);
ok('form submit -> 303 See Other', r.statusCode === 303, `got ${r.statusCode}`);
ok('form submit -> Location: /waitlist/thanks', r.headers.Location === '/waitlist/thanks', JSON.stringify(r.headers));
ok('redirect carries NO query string (the whole point of #829)',
  !String(r.headers.Location).includes('?'), r.headers.Location);
ok('form submit was actually DELIVERED', lastPost !== null && lastPost.text.includes('sam@example.com'));
ok('delivered message carries name and company',
  lastPost && lastPost.text.includes('Sam Visitor') && lastPost.text.includes('Sam Co'));

// The honeypot must stay indistinguishable from success on BOTH encodings.
lastPost = null;
r = await call(waitlistHandler, formReq(WAITLIST_FORM_BODY.replace('&website=', '&website=http%3A%2F%2Fspam')), TOKEN_ENV);
ok('honeypot hit -> the ordinary 303, so a bot learns nothing',
  r.statusCode === 303 && r.headers.Location === '/waitlist/thanks', `${r.statusCode} ${JSON.stringify(r.headers)}`);
ok('honeypot hit delivered NOTHING to Slack', lastPost === null);

r = await call(waitlistHandler, formReq('name=&email=&company='), TOKEN_ENV);
ok('validation failure -> 400 HTML naming the real errors',
  r.statusCode === 400 && r.raw.includes('name is required') && r.raw.includes('email is required'), r.raw);
ok('failure page states nothing was saved', r.raw.includes('Nothing was saved'));
ok('failure page offers a route back', r.raw.includes('/#waitlist'));

r = await call(waitlistHandler, formReq(WAITLIST_FORM_BODY), {});
ok('no token -> 503 HTML naming the real cause',
  r.statusCode === 503 && r.raw.includes('delivery channel is not configured'), r.raw);

// CRITIC FINDING 2, waitlist side.
r = await call(waitlistHandler, formReq('name=A&email=not-an-email&company=C&source_slug=example'), TOKEN_ENV);
ok('the retry link keeps the member page (/example), not the generic homepage',
  r.raw.includes('href="/example#waitlist"'), r.raw);
r = await call(waitlistHandler, formReq('name=A&email=not-an-email&company=C&source_slug=%2F%2Fevil.example'), TOKEN_ENV);
ok('a hostile source_slug falls back to /#waitlist',
  r.raw.includes('href="/#waitlist"') && !r.raw.includes('evil.example'), r.raw);

// CRITIC FINDING 4, waitlist side: the reachable non-fixed message path.
global.fetch = async () => ({ json: async () => ({ ok: false, error: '<script>alert(1)</script>' }) });
r = await call(waitlistHandler, formReq(WAITLIST_FORM_BODY), TOKEN_ENV);
ok('an upstream error containing markup is ESCAPED, not rendered',
  r.statusCode === 502
  && r.raw.includes('&lt;script&gt;alert(1)&lt;/script&gt;')
  && !r.raw.includes('<script>alert(1)'), r.raw);
global.fetch = fetchOk;

console.log('\napi/waitlist.js -- JSON path MUST BE UNCHANGED');
const WAITLIST_JSON = {
  name: 'Sam Visitor', email: 'sam@example.com', company: 'Sam Co',
  referral_text: 'Brian', source_slug: '', website: null,
};
lastPost = null;
r = await call(waitlistHandler, jsonReq(WAITLIST_JSON), TOKEN_ENV);
ok('JSON success -> 200 {ok:true, ref:<slack ts>}',
  r.statusCode === 200 && r.body && r.body.ok === true && r.body.ref === '1785.1234', JSON.stringify(r.body));
ok('JSON success sends no Location header', r.headers.Location === undefined);
ok('JSON success writes no HTML body', r.raw === null);

lastPost = null;
r = await call(waitlistHandler, jsonReq({ ...WAITLIST_JSON, website: 'http://spam' }), TOKEN_ENV);
ok('JSON honeypot -> 200 {ok:true, ref:"received"} (unchanged)',
  r.statusCode === 200 && r.body && r.body.ref === 'received', JSON.stringify(r.body));
ok('JSON honeypot delivered nothing', lastPost === null);

r = await call(waitlistHandler, jsonReq({ ...WAITLIST_JSON, email: 'nope' }), TOKEN_ENV);
ok('JSON validation failure -> 400 JSON, exact error text',
  r.statusCode === 400 && r.body.error.includes('email does not look like an email address'), JSON.stringify(r.body));

r = await call(waitlistHandler, { method: 'GET', headers: {} }, TOKEN_ENV);
ok('GET -> 405 JSON with Allow: POST (unchanged)',
  r.statusCode === 405 && r.headers.Allow === 'POST');

r = await call(waitlistHandler, { method: 'POST', headers: {}, body: WAITLIST_JSON }, TOKEN_ENV);
ok('no content-type -> JSON path (the default did not move)',
  r.statusCode === 200 && r.body && r.body.ok === true, `${r.statusCode} ${JSON.stringify(r.body)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
