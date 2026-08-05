// Proof for api/journey.js: non-sensitive status/support signals post to Slack
// with explicit failures and without forwarding setup tokens or email addresses.
import handler from '../api/journey.js';

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

async function call(req, env = {}) {
  const keys = ['JOURNEY_SLACK_BOT_TOKEN', 'JOURNEY_SLACK_CHANNEL', 'CONTACT_SLACK_BOT_TOKEN', 'CONTACT_SLACK_CHANNEL'];
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

let lastPost = null;
global.fetch = async (url, opts) => {
  lastPost = JSON.parse(opts.body);
  return { json: async () => ({ ok: true, ts: '1776.409' }) };
};

console.log('api/journey.js proof');

let r = await call({ method: 'GET' });
ok('GET -> 405', r.statusCode === 405 && r.headers.Allow === 'POST');

r = await call({ method: 'POST', body: '{nope' });
ok('invalid JSON -> 400', r.statusCode === 400 && /valid JSON/.test(r.body.error));

r = await call({ method: 'POST', body: {} });
ok('empty body -> 400', r.statusCode === 400 && /event_type/.test(r.body.error));

r = await call({ method: 'POST', body: { stage_id: 'aws_account' } });
ok('valid but no token -> 503', r.statusCode === 503 && /not configured/.test(r.body.error));

r = await call(
  { method: 'POST', body: { event_type: 'support_requested', current_step: 'AWS account', support_for: 'aws_account', page: '/status' } },
  { CONTACT_SLACK_BOT_TOKEN: 'xoxb-shared' },
);
ok('CONTACT token fallback -> 200 ok', r.statusCode === 200 && r.body.ok === true && r.body.ref === '1776.409');
ok('defaults to HQ #acorn', lastPost && lastPost.channel === 'C0ATRTVMCH1');
ok('support payload names event and context', /Setup support requested/.test(lastPost.text) && /AWS account/.test(lastPost.text) && /aws_account/.test(lastPost.text));

r = await call(
  { method: 'POST', body: { stage_id: 'server_up', page: '/status?token=secret-token', token: 'secret-token', email: 'person@example.com' } },
  { JOURNEY_SLACK_BOT_TOKEN: 'xoxb-journey', JOURNEY_SLACK_CHANNEL: 'C-JOURNEY' },
);
ok('JOURNEY channel override honored', r.statusCode === 200 && lastPost.channel === 'C-JOURNEY');
ok('does not forward token or email into Slack text', !/secret-token|person@example\.com/.test(lastPost.text));

r = await call(
  { method: 'POST', body: { event_type: 'support_requested', current_step: '<!channel> & step', support_for: '<script>' } },
  { CONTACT_SLACK_BOT_TOKEN: 'xoxb-shared' },
);
ok('Slack markup is escaped', r.statusCode === 200 && !/<!channel>/.test(lastPost.text) && /&lt;!channel&gt; &amp; step/.test(lastPost.text));

global.fetch = async () => ({ json: async () => ({ ok: false, error: 'channel_not_found' }) });
r = await call(
  { method: 'POST', body: { event_type: 'setup_link_requested' } },
  { CONTACT_SLACK_BOT_TOKEN: 'xoxb-shared' },
);
ok('Slack not-ok -> 503 with real error', r.statusCode === 503 && /channel_not_found/.test(r.body.error));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
