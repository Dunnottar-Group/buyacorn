// Proof for api/contact.js: contact form delivery to Slack with explicit
// failures, honeypot handling, env override, and Slack escaping.
import handler from '../api/contact.js';

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

async function call(req, env = {}) {
  const keys = ['CONTACT_SLACK_BOT_TOKEN', 'SLACK_CONTACT_CHANNEL'];
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  const res = mockRes();
  await handler(req, res);
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return res;
}

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const VALID = {
  name: 'Tre Tester',
  email: 'tre@example.com',
  message: 'Can you help me?',
  company: '',
};

let lastPost = null;
global.fetch = async (url, opts) => {
  lastPost = JSON.parse(opts.body);
  return { json: async () => ({ ok: true, ts: '1785.751' }) };
};

console.log('api/contact.js proof');

let r = await call({ method: 'GET' });
ok('GET -> 405', r.statusCode === 405 && r.headers.Allow === 'POST');

r = await call({ method: 'POST', body: '{bad' });
ok('invalid JSON -> 400', r.statusCode === 400 && /valid JSON/.test(r.body.error));

r = await call({ method: 'POST', body: {} });
ok('empty body -> 400', r.statusCode === 400 && /name is required/.test(r.body.error) && /message is required/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, email: 'not-email' } });
ok('bad email -> 400', r.statusCode === 400 && /email/.test(r.body.error));

r = await call({ method: 'POST', body: { ...VALID, company: 'bot-filled' } });
ok('honeypot filled -> 200 acknowledged', r.statusCode === 200 && r.body.ok === true && r.body.ref === 'received');
ok('honeypot filled -> no Slack delivery', lastPost === null);

r = await call({ method: 'POST', body: VALID });
ok('valid but no token -> 503', r.statusCode === 503 && /not configured/.test(r.body.error));

r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test' });
ok('valid token but no SLACK_CONTACT_CHANNEL -> 503', r.statusCode === 503 && /not configured/.test(r.body.error));

r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test', SLACK_CONTACT_CHANNEL: 'C-CONTACT' });
ok('valid + token -> 200 ok', r.statusCode === 200 && r.body.ok === true && r.body.ref === '1785.751');
ok('posts to SLACK_CONTACT_CHANNEL', lastPost && lastPost.channel === 'C-CONTACT');
ok('delivered text carries contact fields', /Website report/.test(lastPost.text) && /Tre Tester/.test(lastPost.text) && /tre@example.com/.test(lastPost.text) && /Can you help me/.test(lastPost.text));

global.fetch = async () => ({ json: async () => ({ ok: false, error: 'channel_not_found' }) });
r = await call({ method: 'POST', body: VALID }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test', SLACK_CONTACT_CHANNEL: 'C-CONTACT' });
ok('Slack not-ok -> 502 with real error', r.statusCode === 502 && /channel_not_found/.test(r.body.error));

global.fetch = async (url, opts) => {
  lastPost = JSON.parse(opts.body);
  return { json: async () => ({ ok: true, ts: 't' }) };
};
r = await call({ method: 'POST', body: { ...VALID, message: '<!channel> & <script>' } }, { CONTACT_SLACK_BOT_TOKEN: 'xoxb-test', SLACK_CONTACT_CHANNEL: 'C-CONTACT' });
ok('Slack markup is escaped', !/<!channel>/.test(lastPost.text) && /&lt;!channel&gt; &amp; &lt;script&gt;/.test(lastPost.text));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
