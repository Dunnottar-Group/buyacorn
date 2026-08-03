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

// ACR-829: where the no-JS applicant goes after a successful native POST.
// The same page static/alpha-submit.js sends the JS applicant to.
const THANKS_PATH = '/alpha/thanks';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  // Vercel parses JSON into req.body; plain node (the local proof harness) does
  // not. Handle both.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return JSON.parse(req.body);
    return req.body;
  }
  const raw = await readRawBody(req);
  return raw ? JSON.parse(raw) : {};
}

// ACR-829 (#829). The form now carries method="POST" action="/api/alpha", so a
// visitor with JavaScript disabled (or whose /static/alpha-submit.js simply
// failed to load) submits NATIVELY, and a native submit is
// `application/x-www-form-urlencoded`, not JSON. Before this, that submit was a
// GET to the page's own URL with name, email, company and the three consent
// values in the QUERY STRING -- browser history, our access logs, and the
// Referer header on the next click.
//
// Accepting only the leak-free markup would have been half a fix: the applicant
// would stop leaking AND stop being recorded. So this endpoint speaks both
// encodings. Everything downstream of the decode -- validation, Slack
// delivery, error handling -- is the SAME code on both paths.
function isFormEncoded(req) {
  const ct = ((req.headers && req.headers['content-type']) || '').toString();
  return ct.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

// A checked HTML checkbox posts its value ("on" by default); an UNCHECKED one
// is absent from the body entirely. validate() requires a literal `true`, and
// that must not change -- the JSON path depends on it and consent is legally
// load-bearing. So the mapping happens HERE, in the decoder, where an encoding
// detail belongs. An explicit negative is honoured as a negative rather than
// read as "a non-empty string, therefore yes".
const CONSENT_FIELDS = ['eula_accepted', 'auto_update_ack', 'data_share_tier3_ack'];
const EXPLICIT_NEGATIVES = new Set(['', 'false', '0', 'off', 'no']);

async function readFormBody(req) {
  let params;
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    // Vercel's Node runtime already parsed it.
    params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.body)) params.append(k, v);
  } else {
    const raw = typeof req.body === 'string' ? req.body : await readRawBody(req);
    params = new URLSearchParams(raw);
  }
  const out = {};
  for (const [k, v] of params) out[k] = v;
  for (const f of CONSENT_FIELDS) {
    out[f] = Object.prototype.hasOwnProperty.call(out, f)
      && !EXPLICIT_NEGATIVES.has(String(out[f]).trim().toLowerCase());
  }
  return out;
}

function htmlEscape(v) {
  return (v === undefined || v === null ? '' : String(v))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A human pressed a button; they get a page, not raw JSON. The message is the
// REAL error state, escaped, never an invented reason and never anything the
// applicant typed echoed back into a document.
function respondFormError(res, status, message) {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Your application was not sent</title></head>
<body>
<h1>Your application was not sent</h1>
<p>Nothing was saved. Here is exactly what went wrong:</p>
<p><strong>${htmlEscape(message)}</strong></p>
<p><a href="/alpha#apply">Go back and try again</a>, or email
<a href="mailto:alpha@buyacorn.com">alpha@buyacorn.com</a> with the same details
and we will add you by hand.</p>
</body></html>
`;
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(page);
}

// 303 See Other, not 302: it tells the browser to follow up with a GET, so a
// refresh on the thanks page cannot re-POST the application.
function respondFormSuccess(res) {
  res.status(303);
  res.setHeader('Location', THANKS_PATH);
  return res.end();
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

  // ACR-829: the ONE branch. Everything below it is shared. A request that does
  // not explicitly declare the form encoding takes the JSON path exactly as it
  // always did, so the fetch path's behaviour is unchanged byte for byte.
  const asForm = isFormEncoded(req);

  let body;
  try {
    body = asForm ? await readFormBody(req) : await readJsonBody(req);
  } catch {
    if (asForm) return respondFormError(res, 400, 'the form data could not be read');
    return res.status(400).json({ ok: false, error: 'request body was not valid JSON' });
  }

  const v = validate(body);
  if (v.errors.length > 0) {
    if (asForm) return respondFormError(res, 400, v.errors.join('; '));
    return res.status(400).json({ ok: false, error: v.errors.join('; ') });
  }

  const token = process.env.ALPHA_SLACK_BOT_TOKEN || process.env.CONTACT_SLACK_BOT_TOKEN;
  const channel =
    process.env.ALPHA_SLACK_CHANNEL || process.env.CONTACT_SLACK_CHANNEL || 'C0ATRTVMCH1'; // HQ #acorn
  if (!token) {
    if (asForm) {
      return respondFormError(res, 503, 'delivery channel is not configured on the server');
    }
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
    const detail = `delivery request failed: ${err && err.name === 'AbortError' ? 'timed out' : 'network error'}`;
    if (asForm) return respondFormError(res, 502, detail);
    return res.status(502).json({ ok: false, error: detail });
  }

  if (!slack || slack.ok !== true) {
    const detail = `delivery was not confirmed (${(slack && slack.error) || 'no response detail'})`;
    if (asForm) return respondFormError(res, 502, detail);
    return res.status(502).json({ ok: false, error: detail });
  }

  // Confirmed at the destination. The no-JS applicant gets the same thanks page
  // the JS applicant gets, by redirect; the fetch path gets the same JSON it
  // always got.
  if (asForm) return respondFormSuccess(res);
  return res.status(200).json({ ok: true, ref: slack.ts });
}
