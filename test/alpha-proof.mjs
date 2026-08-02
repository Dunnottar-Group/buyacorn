// ACR-769 proof: exercise api/alpha.js across every branch with a mocked
// req/res and a mocked global.fetch (no real Slack call). Run: node test/alpha-proof.mjs
import handler from '../api/alpha.js';

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
  for (const k of ['ALPHA_SLACK_BOT_TOKEN', 'CONTACT_SLACK_BOT_TOKEN', 'ALPHA_SLACK_CHANNEL', 'CONTACT_SLACK_CHANNEL']) {
    saved[k] = process.env[k]; delete process.env[k];
  }
  Object.assign(process.env, env);
  const res = mockRes();
  await handler(req, res);
  Object.assign(process.env, saved);
  return res;
}
let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

const VALID = {
  name: 'Tre Tester', email: 'tre@example.com', company: 'Acme Widgets',
  referral_text: 'Brian', source_slug: 'johnrobb',
  eula_accepted: true, auto_update_ack: true, data_share_tier3_ack: true,
};

// capture Slack payloads
let lastPost = null;
global.fetch = async (url, opts) => { lastPost = JSON.parse(opts.body); return { json: async () => ({ ok: true, ts: '1785.9999' }) }; };

console.log('ACR-769 api/alpha.js proof');

let r = await call({ method: 'GET' });
ok('GET -> 405', r.statusCode === 405 && r.headers.Allow === 'POST');

r = await call({ method: 'POST', body: '{not json' });
ok('invalid JSON -> 400', r.statusCode === 400 && /valid JSON/.test(r.body.error));

r = await call({ method: 'POST', body: {} });
ok('empty body -> 400 with required errors', r.statusCode === 400 && /name is required/.test(r.body.error) && /company is required/.test(r.body.error) && /EULA/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, eula_accepted: false } });
ok('EULA not accepted -> 400', r.statusCode === 400 && /EULA must be accepted/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, auto_update_ack: false, data_share_tier3_ack: false } });
ok('missing two consents -> 400 names both', r.statusCode === 400 && /auto-update/.test(r.body.error) && /tier-3/.test(r.body.error));

r = await call({ method: 'POST', body: VALID }); // no token in env
ok('valid but no token -> 503', r.statusCode === 503 && /not configured/.test(r.body.error));

// company is a REAL field, NOT a honeypot: a filled company must SUCCEED
lastPost = null;
r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('valid + token (via CONTACT fallback) -> 200 ok', r.statusCode === 200 && r.body.ok === true && r.body.ref === '1785.9999');
ok('company (real field) NOT dropped as honeypot', r.statusCode === 200);
ok('delivered text carries all three consents', lastPost && /EULA: yes/.test(lastPost.text) && /auto-update: yes/.test(lastPost.text) && /tier-3 telemetry: yes/.test(lastPost.text));
ok('delivered text carries company + email + source', lastPost && /Acme Widgets/.test(lastPost.text) && /tre@example.com/.test(lastPost.text) && /johnrobb/.test(lastPost.text));
ok('posts to HQ #acorn channel default', lastPost && lastPost.channel === 'C0ATRTVMCH1');

// dedicated ALPHA token wins over CONTACT
r = await call({ method: 'POST', body: VALID }, { ALPHA_SLACK_BOT_TOKEN: 'xoxb-alpha', ALPHA_SLACK_CHANNEL: 'C-ALPHA' });
ok('ALPHA_SLACK_CHANNEL override honored', r.statusCode === 200 && lastPost.channel === 'C-ALPHA');

// Slack rejects -> 502 explicit, never a false success
global.fetch = async () => ({ json: async () => ({ ok: false, error: 'channel_not_found' }) });
r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('Slack not-ok -> 502 with real error', r.statusCode === 502 && /channel_not_found/.test(r.body.error));

// injection: a broadcast attempt in a field must be neutralized, not fired
global.fetch = async (url, opts) => { lastPost = JSON.parse(opts.body); return { json: async () => ({ ok: true, ts: 't' }) }; };
r = await call({ method: 'POST', body: { ...VALID, company: '<!channel> Evil & Co <script>' } }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('user field escaped (no live <!channel>)', r.statusCode === 200 && !/<!channel>/.test(lastPost.text) && /&lt;!channel&gt;/.test(lastPost.text) && /Evil &amp; Co/.test(lastPost.text));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
