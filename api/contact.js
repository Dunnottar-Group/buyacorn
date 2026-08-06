// ACR-751: real transport for buyacorn.com/contact.
// Replaces the mailto: form. Delivers the report to the contact leads channel
// configured by SLACK_CONTACT_CHANNEL via Slack
// chat.postMessage and confirms success to the user ONLY after Slack
// confirms delivery. Any other outcome is surfaced as an explicit failure
// with the real error state. Never a silent drop, never an invented reason.
//
// Secrets: CONTACT_SLACK_BOT_TOKEN must be set as a Vercel environment
// variable (server side only). It is never present in client code or in
// this repository.

const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_MESSAGE = 5000;

async function readJsonBody(req) {
  // Vercel parses JSON bodies into req.body; plain node (local proof harness)
  // does not. Handle both.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return JSON.parse(req.body);
    return req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function validate(body) {
  const errors = [];
  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim();
  const message = (body.message || '').toString().trim();
  if (!name) errors.push('name is required');
  if (name.length > MAX_NAME) errors.push('name is too long');
  if (!email) errors.push('email is required');
  else if (email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('email does not look like an email address');
  }
  if (!message) errors.push('message is required');
  if (message.length > MAX_MESSAGE) errors.push(`message is too long (limit ${MAX_MESSAGE} characters)`);
  return { errors, name, email, message };
}

function slackEscape(v) {
  return (v || '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

  // Honeypot: the visible form never fills this field. A submission that
  // fills it is automated; acknowledge without delivering so bots learn
  // nothing. Real users are unaffected.
  if ((body.company || '').toString().trim() !== '') {
    return res.status(200).json({ ok: true, ref: 'received' });
  }

  const { errors, name, email, message } = validate(body);
  if (errors.length > 0) {
    return res.status(400).json({ ok: false, error: errors.join('; ') });
  }

  const token = process.env.CONTACT_SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CONTACT_CHANNEL;
  if (!token || !channel) {
    // Real state: the delivery channel is not configured on this deployment.
    return res.status(503).json({
      ok: false,
      error: 'delivery channel is not configured on the server',
    });
  }

  const text = [
    ':inbox_tray: *Website report* (buyacorn.com /contact form)',
    `*From:* ${slackEscape(name)} &lt;${slackEscape(email)}&gt;`,
    `*Received:* ${new Date().toISOString()} (UTC)`,
    '*Message:*',
    slackEscape(message),
  ].join('\n');

  let slack;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    slack = await resp.json();
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: `delivery request failed: ${err && err.name === 'AbortError' ? 'timed out' : 'network error'}`,
    });
  }

  if (!slack || slack.ok !== true) {
    return res.status(502).json({
      ok: false,
      error: `delivery was not confirmed (${(slack && slack.error) || 'no response detail'})`,
    });
  }

  // Confirmed at the destination: Slack returned ok:true with a message ts.
  return res.status(200).json({ ok: true, ref: slack.ts });
}
