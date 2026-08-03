// ACR-779: real transport for the buyacorn.com homepage waitlist form.
//
// The homepage (and /example) waitlist form POSTs JSON to /api/waitlist, but
// no handler existed in this repo after the static-pages migration, so every
// JS-enabled submit hit 404. Worse than /alpha's 404 (#769): the old
// static/waitlist-submit.js caught that failure and called form.submit(),
// firing the form's `action="mailto:waitlist@buyacorn.com"` and serializing
// the visitor's name, email and company into a mail compose window as visible
// urlencoded text. That is the #387 PII class. This endpoint is one half of
// the fix; removing the mailto path from the form and the JS is the other.
//
// Modeled on api/contact.js (ACR-751) and api/alpha.js (ACR-769): deliver to
// HQ #acorn via Slack chat.postMessage and confirm success to the visitor ONLY
// after Slack confirms delivery, returning the Slack message ts as a reference
// the visitor can quote. Any other outcome is surfaced as an explicit failure
// carrying the real error state. Never a silent drop, never an invented
// reason.
//
// Fields accepted are EXACTLY the fields static/waitlist-submit.js posts:
// name, email, company, referral_text, source_slug -- plus `website`, which is
// a honeypot (see below). company is a REAL required field here, exactly as on
// /alpha, so unlike api/contact.js it must never be treated as a bot trap.
//
// Honeypot: `website` is a hidden field no sighted visitor ever fills. A
// submission that fills it is automated; it is acknowledged without delivering
// so bots learn nothing, which is the same shape api/contact.js uses. This is
// the ONE path that returns success without a Slack delivery, and it is
// deliberate.
//
// Secrets: a Slack bot token must be set server-side as a Vercel env var --
// WAITLIST_SLACK_BOT_TOKEN, or CONTACT_SLACK_BOT_TOKEN as a fallback so this
// works with the same token /contact, /alpha and /reserve already use. Never
// in client code, never in this repository.

const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_COMPANY = 200;
const MAX_REFERRAL = 2000;
const MAX_SLUG = 200;

async function readJsonBody(req) {
  // Vercel parses JSON into req.body; plain node (the local proof harness) does
  // not. Handle both.
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
  // The form JS sends null (not "") for the two optional fields when their
  // inputs are absent, e.g. /example has no referral_text input.
  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim();
  const company = (body.company || '').toString().trim();
  const referral = (body.referral_text || '').toString().trim();
  const slug = (body.source_slug || '').toString().trim();

  if (!name) errors.push('name is required');
  if (name.length > MAX_NAME) errors.push('name is too long');
  if (!email) errors.push('email is required');
  else if (email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('email does not look like an email address');
  }
  if (!company) errors.push('company is required');
  if (company.length > MAX_COMPANY) errors.push('company is too long');
  if (referral.length > MAX_REFERRAL) errors.push('referral text is too long');
  if (slug.length > MAX_SLUG) errors.push('source_slug is too long');

  return { errors, name, email, company, referral, slug };
}

// Slack message text treats &, <, > as control characters (mrkdwn / <!channel>
// broadcasts, <url|label> links). Escape every visitor-supplied value so a
// field like a company name of "<!channel>" is shown literally, never fires a
// broadcast or spoofs a link. Per Slack's own escaping rules only these three
// need replacing, ampersand first.
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

  // Honeypot, checked before validation so a bot cannot tell the two apart
  // from the response.
  if ((body.website || '').toString().trim() !== '') {
    return res.status(200).json({ ok: true, ref: 'received' });
  }

  const v = validate(body);
  if (v.errors.length > 0) {
    return res.status(400).json({ ok: false, error: v.errors.join('; ') });
  }

  const token = process.env.WAITLIST_SLACK_BOT_TOKEN || process.env.CONTACT_SLACK_BOT_TOKEN;
  const channel =
    process.env.WAITLIST_SLACK_CHANNEL || process.env.CONTACT_SLACK_CHANNEL || 'C0ATRTVMCH1'; // HQ #acorn
  if (!token) {
    return res.status(503).json({
      ok: false,
      error: 'delivery channel is not configured on the server',
    });
  }

  const lines = [
    ':envelope_with_arrow: *Waitlist request* (buyacorn.com)',
    `*Name:* ${slackEscape(v.name)}`,
    `*Email:* ${slackEscape(v.email)}`,
    `*Company:* ${slackEscape(v.company)}`,
    `*Received:* ${new Date().toISOString()} (UTC)`,
  ];
  if (v.slug) lines.push(`*Source:* ${slackEscape(v.slug)}`);
  if (v.referral) lines.push(`*Who sent them:* ${slackEscape(v.referral)}`);
  const text = lines.join('\n');

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
