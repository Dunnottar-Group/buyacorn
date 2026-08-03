// ACR-779 proof: exercise api/waitlist.js across every branch with a mocked
// req/res and a mocked global.fetch (no real Slack call).
// Run: node test/waitlist-proof.mjs
//
// The env list in call() below MUST name every env var the handler reads. A
// short list does not fail loudly: an override set by one test leaks into
// every later test and the suite stays green while testing the wrong
// configuration (that defect was found live in the ACR-815 harness on
// 2026-08-03). Keep it in sync with api/waitlist.js.
import { readFile } from 'node:fs/promises';
import handler from '../api/waitlist.js';

const HANDLER_ENV = [
  'WAITLIST_SLACK_BOT_TOKEN',
  'CONTACT_SLACK_BOT_TOKEN',
  'WAITLIST_SLACK_CHANNEL',
  'CONTACT_SLACK_CHANNEL',
];

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

async function call(req, env = {}) {
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

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// Exactly the payload static/waitlist-submit.js posts from the homepage.
const VALID = {
  name: 'Tre Tester',
  email: 'tre@example.com',
  company: 'Acme Widgets',
  referral_text: 'Brian',
  source_slug: '',
  website: null,
};

let lastPost = null;
const fetchOk = async (url, opts) => {
  lastPost = JSON.parse(opts.body);
  lastPost.__url = url;
  return { json: async () => ({ ok: true, ts: '1785.9999' }) };
};
global.fetch = fetchOk;

console.log('ACR-779 api/waitlist.js proof');

// --- method / body shape -------------------------------------------------
let r = await call({ method: 'GET' });
ok('GET -> 405 with Allow: POST', r.statusCode === 405 && r.headers.Allow === 'POST');

r = await call({ method: 'PUT' });
ok('PUT -> 405', r.statusCode === 405);

r = await call({ method: 'POST', body: '{not json' });
ok('invalid JSON -> 400', r.statusCode === 400 && /valid JSON/.test(r.body.error));

// --- validation ----------------------------------------------------------
r = await call({ method: 'POST', body: {} });
ok('empty body -> 400 naming all three required fields',
  r.statusCode === 400 && /name is required/.test(r.body.error)
  && /email is required/.test(r.body.error) && /company is required/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, email: 'not-an-email' } });
ok('bad email -> 400', r.statusCode === 400 && /email does not look like/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, name: 'x'.repeat(201) } });
ok('over-long name -> 400', r.statusCode === 400 && /name is too long/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, referral_text: 'x'.repeat(2001) } });
ok('over-long referral -> 400', r.statusCode === 400 && /referral text is too long/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, company: '   ' } });
ok('whitespace-only company -> 400', r.statusCode === 400 && /company is required/.test(r.body.error));

// The /example page has no referral_text input, so its JS posts null for both
// optional fields. Nulls must be accepted, not rejected or stringified.
lastPost = null;
r = await call(
  { method: 'POST', body: { name: 'N', email: 'n@e.com', company: 'C', referral_text: null, source_slug: 'example', website: null } },
  { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('/example shape (null optionals) -> 200', r.statusCode === 200 && r.body.ok === true);
ok('null referral_text is omitted, never printed as "null"',
  lastPost && !/null/.test(lastPost.text) && !/Who sent them/.test(lastPost.text));
ok('source_slug delivered', lastPost && /\*Source:\* example/.test(lastPost.text));

// --- unconfigured server -------------------------------------------------
r = await call({ method: 'POST', body: VALID });
ok('valid but no token -> 503 real state', r.statusCode === 503 && /not configured/.test(r.body.error));
ok('503 is not a success', r.statusCode === 503 && r.body.ok === false && r.body.ref === undefined);

// --- honeypot ------------------------------------------------------------
lastPost = null;
r = await call({ method: 'POST', body: { ...VALID, website: 'http://spam.example' } },
  { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('honeypot filled -> 200 acknowledged', r.statusCode === 200 && r.body.ok === true && r.body.ref === 'received');
ok('honeypot filled -> nothing delivered to Slack', lastPost === null);

lastPost = null;
r = await call({ method: 'POST', body: { ...VALID, website: '' } }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('empty honeypot (the real-visitor case) -> delivered', r.statusCode === 200 && lastPost !== null);

// company is a REAL field here, NOT the contact.js honeypot: it must deliver.
lastPost = null;
r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('company (real field) NOT dropped as a honeypot', r.statusCode === 200 && lastPost !== null);

// --- happy path ----------------------------------------------------------
ok('success returns the Slack ts as ref', r.body.ok === true && r.body.ref === '1785.9999');
ok('delivered text carries name, email, company, referral',
  lastPost && /Tre Tester/.test(lastPost.text) && /tre@example.com/.test(lastPost.text)
  && /Acme Widgets/.test(lastPost.text) && /Brian/.test(lastPost.text));
ok('posts to HQ #acorn by default', lastPost && lastPost.channel === 'C0ATRTVMCH1');
ok('posts to chat.postMessage', lastPost && lastPost.__url === 'https://slack.com/api/chat.postMessage');
ok('labelled as a waitlist request from buyacorn.com', lastPost && /Waitlist request/.test(lastPost.text));

r = await call({ method: 'POST', body: VALID },
  { WAITLIST_SLACK_BOT_TOKEN: 'xoxb-waitlist', WAITLIST_SLACK_CHANNEL: 'C-WAIT' });
ok('WAITLIST_SLACK_CHANNEL override honored', r.statusCode === 200 && lastPost.channel === 'C-WAIT');

// Leak check for the false-green class: the override above must not survive.
r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('env from a previous test did NOT leak into this one', lastPost.channel === 'C0ATRTVMCH1');

// --- delivery failures ---------------------------------------------------
global.fetch = async () => ({ json: async () => ({ ok: false, error: 'channel_not_found' }) });
r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('Slack not-ok -> 502 carrying the REAL error', r.statusCode === 502 && /channel_not_found/.test(r.body.error));
ok('Slack not-ok is never reported as success', r.body.ok === false && r.body.ref === undefined);

global.fetch = async () => { throw new Error('boom'); };
r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('network error -> 502 network error', r.statusCode === 502 && /network error/.test(r.body.error));

global.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('timeout -> 502 timed out', r.statusCode === 502 && /timed out/.test(r.body.error));

// --- injection -----------------------------------------------------------
global.fetch = fetchOk;
r = await call({ method: 'POST', body: { ...VALID, company: '<!channel> Evil & Co <https://x|click>' } },
  { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('broadcast/link injection neutralized',
  r.statusCode === 200 && lastPost && !/<!channel>/.test(lastPost.text)
  && /&lt;!channel&gt;/.test(lastPost.text) && /Evil &amp; Co/.test(lastPost.text));

// --- the bug itself: no mailto anywhere in the response path -------------
r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('no mailto in any response body', !/mailto/i.test(JSON.stringify(r.body)));

// --- the PII path is gone from the shipped front end ---------------------
// Source-level, because the leak lived in the page and the script, not in the
// handler: a green handler suite would say nothing about it.
const enc = 'utf8';
const submitJs = await readFile(new URL('../public/static/waitlist-submit.js', import.meta.url), enc);
// Comments in this file discuss form.submit() by name (that is the bug being
// closed), so the assertion runs against the code with comments stripped.
const submitCode = submitJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('waitlist-submit.js code no longer calls form.submit()', !/form\.submit\(/.test(submitCode));
ok('waitlist-submit.js contains no mailto: URL', !/mailto:/i.test(submitJs));
ok('waitlist-submit.js sends the honeypot field', /website/.test(submitJs));
ok('waitlist-submit.js says the details were NOT sent on failure', /NOT sent/.test(submitJs));

for (const page of ['../public/index.html', '../public/example/index.html']) {
  const html = await readFile(new URL(page, import.meta.url), enc);
  const form = /<form[^>]*id="waitlist-form"[^>]*>/.exec(html);
  ok(`${page}: waitlist form found`, !!form);
  // ACR-829 INVERTED THIS CHECK: no action at all meant a GET submit to the
  // page's own URL with the visitor's fields in the query string (#829). The
  // rule now is a real POST to a real same-origin endpoint.
  ok(`${page}: form declares method="POST"`, form && /\bmethod="POST"/i.test(form[0]), form && form[0]);
  ok(`${page}: form posts to /api/waitlist`, form && /\baction="\/api\/waitlist"/.test(form[0]), form && form[0]);
  ok(`${page}: form action carries no URL scheme`,
    form && !/\baction="[a-zA-Z][a-zA-Z0-9+.-]*:/.test(form[0]), form && form[0]);
  ok(`${page}: no mailto: URL anywhere on the page`, !/mailto:/i.test(html));
  ok(`${page}: error box present for the honest failure path`, /id="waitlist-form-error"/.test(html));
  ok(`${page}: honeypot field present`, /name="website"/.test(html));
}

const thanksJs = await readFile(new URL('../public/static/waitlist-thanks.js', import.meta.url), enc);
ok('thanks page renders ref with textContent, not innerHTML', /textContent/.test(thanksJs) && !/innerHTML/.test(thanksJs));
ok('thanks page rejects a ref that is not a delivery id', /\[A-Za-z0-9\._-\]\{1,40\}/.test(thanksJs));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
