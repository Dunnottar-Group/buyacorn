// ACR-769 (P0): real transport for the buyacorn.com/alpha application form.
//
// The /alpha page's static/alpha-submit.js POSTs JSON to /api/alpha, but no
// handler existed in this repo after the static-pages migration (commit
// 995271e carried the pages, not the July backend), so every JS-enabled
// applicant hit 404 -> "Something went wrong" forever. This restores a real
// endpoint modeled on api/contact.js (ACR-751): deliver the application to HQ
// #acorn via Slack chat.postMessage and confirm success ONLY after Slack
// confirms delivery. Never a silent drop, never an invented reason.
//
// UNLIKE contact.js there is NO honeypot: the alpha form's `company` field is a
// REAL required field (the applicant's company), so it must never be treated
// as a bot trap. The alpha form (public/alpha/index.html) carries no honeypot
// field, so none is checked here.
//
// The three consent checkboxes (EULA / auto-update / tier-3 telemetry) are
// `required` in the form and legally load-bearing; a submission missing any of
// them is rejected, and all three booleans are recorded in the delivered
// message so consent is captured in a structured, durable place.
//
// Secrets: a Slack bot token must be set server-side as a Vercel env var --
// ALPHA_SLACK_BOT_TOKEN, or CONTACT_SLACK_BOT_TOKEN as a fallback so this
// works with the same token /contact already uses. Never in client code or
// this repo.

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
  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim();
  const company = (body.company || '').toString().trim();
  const referral = (body.referral_text || '').toString().trim();
  const slug = (body.source_slug || '').toString().trim();
  // Consent booleans: accept only a real affirmative. A missing or non-true
  // value is a non-consent, never assumed.
  const eula = body.eula_accepted === true;
  const autoUpdate = body.auto_update_ack === true;
  const tier3 = body.data_share_tier3_ack === true;

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
  if (!eula) errors.push('the EULA must be accepted');
  if (!autoUpdate) errors.push('the auto-update acknowledgement is required');
  if (!tier3) errors.push('the tier-3 telemetry acknowledgement is required');

  return { errors, name, email, company, referral, slug, eula, autoUpdate, tier3 };
}

// Slack message text treats &, <, > as control characters (mrkdwn / <!channel>
// broadcasts, <url|label> links). Escape every applicant-supplied value so a
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

  const v = validate(body);
  if (v.errors.length > 0) {
    return res.status(400).json({ ok: false, error: v.errors.join('; ') });
  }

  const token = process.env.ALPHA_SLACK_BOT_TOKEN || process.env.CONTACT_SLACK_BOT_TOKEN;
  const channel =
    process.env.ALPHA_SLACK_CHANNEL || process.env.CONTACT_SLACK_CHANNEL || 'C0ATRTVMCH1'; // HQ #acorn
  if (!token) {
    return res.status(503).json({
      ok: false,
      error: 'delivery channel is not configured on the server',
    });
  }

  const yn = (b) => (b ? 'yes' : 'NO');
  const lines = [
    ':seedling: *Alpha application* (buyacorn.com /alpha)',
    `*Name:* ${slackEscape(v.name)}`,
    `*Email:* ${slackEscape(v.email)}`,
    `*Company:* ${slackEscape(v.company)}`,
    `*Received:* ${new Date().toISOString()} (UTC)`,
    `*Consent* -- EULA: ${yn(v.eula)} | auto-update: ${yn(v.autoUpdate)} | tier-3 telemetry: ${yn(v.tier3)}`,
  ];
  if (v.slug) lines.push(`*Source:* ${slackEscape(v.slug)}`);
  if (v.referral) lines.push(`*Heard about it via:* ${slackEscape(v.referral)}`);
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

  return res.status(200).json({ ok: true, ref: slack.ts });
}
