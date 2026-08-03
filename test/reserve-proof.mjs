// ACR-790 proof: exercise api/reserve.js across every branch with a mocked
// req/res and a mocked global.fetch (no real Slack call).
// Run: node test/reserve-proof.mjs
import handler from '../api/reserve.js';

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
  // Every env var the handler reads must be listed here. A missing name does not
  // fail loudly: it leaks the previous test's value into the next one, so the suite
  // stays green while silently testing the wrong configuration. RESERVE_NOTIFY_USER_ID
  // was missing when it was added and the override leaked forward exactly that way.
  for (const k of ['RESERVE_SLACK_BOT_TOKEN', 'CONTACT_SLACK_BOT_TOKEN', 'RESERVE_SLACK_CHANNEL', 'CONTACT_SLACK_CHANNEL', 'RESERVE_NOTIFY_USER_ID']) {
    saved[k] = process.env[k]; delete process.env[k];
  }
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
    for (const [k, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[k]; else process.env[k] = val;
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
const TOKEN = { RESERVE_SLACK_BOT_TOKEN: 'xoxb-test' };

// capture Slack payloads
let lastPost = null;
let slackReply = { ok: true, ts: '1785.0001' };
global.fetch = async (url, opts) => {
  lastPost = JSON.parse(opts.body);
  return { json: async () => slackReply };
};

console.log('ACR-790 api/reserve.js proof');

let r = await call({ method: 'GET' });
ok('GET -> 405 with Allow: POST', r.statusCode === 405 && r.headers.Allow === 'POST');

r = await call({ method: 'POST', body: '{not json' });
ok('invalid JSON -> 400', r.statusCode === 400 && /valid JSON/.test(r.body.error));

r = await call({ method: 'POST', body: {} });
ok('empty body -> 400 naming every missing field',
  r.statusCode === 400 && /name is required/.test(r.body.error)
  && /email is required/.test(r.body.error) && /company is required/.test(r.body.error)
  && /plan choice is required/.test(r.body.error)
  && /terms must be acknowledged/.test(r.body.error)
  && /no payment is taken today/.test(r.body.error), JSON.stringify(r.body));

r = await call({ method: 'POST', body: { ...VALID, email: 'not-an-email' } });
ok('malformed email -> 400', r.statusCode === 400 && /does not look like an email/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, terms_ack: false } });
ok('terms not acknowledged -> 400', r.statusCode === 400 && /terms must be acknowledged/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, no_charge_ack: false } });
ok('no-charge acknowledgement missing -> 400', r.statusCode === 400 && /no payment is taken today/.test(r.body.error));

// Consent must be a real boolean true. A truthy string is NOT consent.
r = await call({ method: 'POST', body: { ...VALID, terms_ack: 'yes' } });
ok('truthy non-boolean is NOT acknowledgement -> 400', r.statusCode === 400 && /terms must be acknowledged/.test(r.body.error));

// A tampered plan must never reach #acorn as an invented price.
r = await call({ method: 'POST', body: { ...VALID, plan: 'free' }, }, TOKEN);
ok('unknown plan -> 400, never passed through', r.statusCode === 400 && /not one of the offered options/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, name: 'x'.repeat(201) } }, TOKEN);
ok('over-long name -> 400', r.statusCode === 400 && /name is too long/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, notes: 'x'.repeat(2001) } }, TOKEN);
ok('over-long notes -> 400', r.statusCode === 400 && /notes are too long/.test(r.body.error));

r = await call({ method: 'POST', body: VALID }); // no token in env
ok('valid but no token -> 503, never a false success', r.statusCode === 503 && /not configured/.test(r.body.error));

// company is a REAL required field here (a seat is sold to a company), NOT a
// honeypot: a filled company must SUCCEED.
lastPost = null;
r = await call({ method: 'POST', body: VALID }, TOKEN);
ok('valid submission -> 200 with Slack ts as ref', r.statusCode === 200 && r.body.ok === true && r.body.ref === '1785.0001');
ok('company is a real field, filling it does not reject', r.statusCode === 200);
ok('delivered to HQ #acorn by default', lastPost && lastPost.channel === 'C0ATRTVMCH1');
ok('message carries the ruled plan text, not a bare code',
  lastPost && /\$2,500\/mo \(half of \$5,000 retail, for life\)/.test(lastPost.text), lastPost && lastPost.text);
ok('message states NO MONEY HAS MOVED', lastPost && /NO MONEY HAS MOVED/.test(lastPost.text));
ok('message never calls it a sale', lastPost && !/\bsold\b/i.test(lastPost.text));
ok('name, email, company, source and notes all delivered',
  lastPost && /Dana Buyer/.test(lastPost.text) && /dana@example\.com/.test(lastPost.text)
  && /Chang Robotics/.test(lastPost.text) && /johnrobb/.test(lastPost.text)
  && /Met Brian at JVC/.test(lastPost.text));

// ACR-815: the founder must be tagged, or /reserve/thanks promises a personal
// follow-up that nobody is told to make.
ok('founder is tagged on the reservation', lastPost && /<@U0AU1SJGS92>/.test(lastPost.text), lastPost && lastPost.text);
ok('the tag is on the first line, where it is seen', lastPost && /^:handshake: <@U0AU1SJGS92>/.test(lastPost.text));

lastPost = null;
r = await call({ method: 'POST', body: VALID }, { ...TOKEN, RESERVE_NOTIFY_USER_ID: 'U0OVERRIDE' });
ok('notify target overridable without a deploy', r.statusCode === 200 && /<@U0OVERRIDE>/.test(lastPost.text));

// A buyer must never be able to forge a mention through a form field: slackEscape
// turns their angle brackets into entities, so only the handler's own tag is live.
lastPost = null;
r = await call({ method: 'POST', body: { ...VALID, name: '<@U0AU1SJGS92> <!here>' } }, TOKEN);
ok('buyer cannot forge a second mention or an @here',
  r.statusCode === 200 && (lastPost.text.match(/<@/g) || []).length === 1 && !/<!here>/.test(lastPost.text),
  lastPost && lastPost.text);

// Slack control characters in buyer input must be neutralised.
lastPost = null;
r = await call({ method: 'POST', body: { ...VALID, company: '<!channel> & <http://evil|click>' } }, TOKEN);
ok('slack control characters escaped, no broadcast, no spoofed link',
  r.statusCode === 200 && lastPost && !/<!channel>/.test(lastPost.text)
  && /&lt;!channel&gt;/.test(lastPost.text) && /&amp;/.test(lastPost.text), lastPost && lastPost.text);

// Fallback token path: the shared /contact token works.
lastPost = null;
r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-shared' });
ok('CONTACT_SLACK_BOT_TOKEN fallback works', r.statusCode === 200);

r = await call({ method: 'POST', body: VALID }, { ...TOKEN, RESERVE_SLACK_CHANNEL: 'C0OVERRIDE' });
ok('channel override honoured', r.statusCode === 200 && lastPost.channel === 'C0OVERRIDE');

// Each plan value renders its own ruled label.
for (const [plan, needle] of [['annual', '\\$25,000/yr'], ['undecided', 'plan not chosen yet']]) {
  lastPost = null;
  r = await call({ method: 'POST', body: { ...VALID, plan } }, TOKEN);
  ok(`plan "${plan}" renders its ruled label`, r.statusCode === 200 && new RegExp(needle).test(lastPost.text), lastPost && lastPost.text);
}

// Delivery failures must never report success.
slackReply = { ok: false, error: 'channel_not_found' };
r = await call({ method: 'POST', body: VALID }, TOKEN);
ok('Slack says not-ok -> 502 quoting the real reason, never invented',
  r.statusCode === 502 && /channel_not_found/.test(r.body.error));

slackReply = { ok: true, ts: '1785.0002' };
global.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
r = await call({ method: 'POST', body: VALID }, TOKEN);
ok('network timeout -> 502 named as a timeout', r.statusCode === 502 && /timed out/.test(r.body.error));

global.fetch = async () => { throw new Error('boom'); };
r = await call({ method: 'POST', body: VALID }, TOKEN);
ok('network error -> 502, no false success', r.statusCode === 502 && /network error/.test(r.body.error));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
