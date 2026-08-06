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
// the configured waitlist Slack channel via chat.postMessage and confirm
// success to the visitor ONLY
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

// ACR-829: where the no-JS visitor goes after a successful native POST. The
// same page static/waitlist-submit.js sends the JS visitor to.
//
// Deliberately WITHOUT the `?ref=` query the JS path appends. That reference is
// rendered by static/waitlist-thanks.js, which a no-JS visitor is not running,
// so the query would be noise in the URL of the very visitor this fix exists to
// keep data out of the URL for.
const THANKS_PATH = '/waitlist/thanks';

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

// ACR-829 (#829). The form now carries method="POST" action="/api/waitlist", so
// a visitor with JavaScript disabled (or whose /static/waitlist-submit.js
// failed to load) submits NATIVELY, and a native submit is
// `application/x-www-form-urlencoded`, not JSON. Before this, that submit was a
// GET to the page's own URL with name, email and company in the QUERY STRING --
// browser history, our access logs, and the Referer header on the next click.
//
// Accepting only the leak-free markup would have been half a fix: the visitor
// would stop leaking AND stop being recorded. So this endpoint speaks both
// encodings. Everything downstream of the decode -- honeypot, validation, Slack
// delivery, error handling -- is the SAME code on both paths.
function isFormEncoded(req) {
  const ct = ((req.headers && req.headers['content-type']) || '').toString();
  return ct.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

async function readFormBody(req) {
  let params;
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    // Vercel's Node runtime already parsed it. A repeated key can arrive as an
    // ARRAY; append each element so the last-wins rule below is the same one
    // URLSearchParams would have applied to the raw body.
    params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.body)) {
      if (Array.isArray(v)) for (const item of v) params.append(k, item);
      else params.append(k, v);
    }
  } else {
    const raw = typeof req.body === 'string' ? req.body : await readRawBody(req);
    params = new URLSearchParams(raw);
  }
  const out = {};
  for (const [k, v] of params) out[k] = v; // last wins, as URLSearchParams reads it
  return out;
}

// CRITIC DEFECT 2: the error page used to hard-code a link back to /#waitlist,
// so a no-JS visitor who came from a member page such as /example and mistyped
// their email was sent to the generic homepage, whose hidden source_slug is
// empty. The retry then lost the referral credit -- attribution destroyed on
// the failure path, by new surface this PR introduced.
//
// The slug is visitor-supplied, so it is not interpolated on trust: only a
// strict lowercase slug is accepted, it can contain no slash, dot, colon or
// scheme, and it is emitted through htmlEscape. Same-origin by construction.
const SAFE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function backLinkFor(slug, fallback) {
  const s = (slug || '').toString().trim().toLowerCase();
  return SAFE_SLUG_RE.test(s) ? `/${s}#waitlist` : fallback;
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
// visitor typed echoed back into a document.
function respondFormError(res, status, message, backHref = '/#waitlist') {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Your details were not sent</title></head>
<body>
<h1>Your details were not sent</h1>
<p>Nothing was saved. Here is exactly what went wrong:</p>
<p><strong>${htmlEscape(message)}</strong></p>
<p><a href="${htmlEscape(backHref)}">Go back and try again</a>, or email
<a href="mailto:brian@buyacorn.com">brian@buyacorn.com</a> with your name
and company and we will add you by hand.</p>
</body></html>
`;
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(page);
}

// 303 See Other, not 302: it tells the browser to follow up with a GET, so a
// refresh on the thanks page cannot re-POST the request.
function respondFormSuccess(res) {
  res.status(303);
  res.setHeader('Location', THANKS_PATH);
  return res.end();
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

  // Honeypot, checked before validation so a bot cannot tell the two apart
  // from the response. A form-encoded honeypot hit gets the ordinary success
  // redirect for the same reason the JSON path gets an ordinary success body:
  // the bot must learn nothing from the difference.
  if ((body.website || '').toString().trim() !== '') {
    if (asForm) return respondFormSuccess(res);
    return res.status(200).json({ ok: true, ref: 'received' });
  }

  // The page this visitor actually submitted from, so a retry keeps its
  // referral credit. Derived from the form's own hidden field, validated.
  const backHref = backLinkFor(body && body.source_slug, '/#waitlist');

  const v = validate(body);
  if (v.errors.length > 0) {
    if (asForm) return respondFormError(res, 400, v.errors.join('; '), backHref);
    return res.status(400).json({ ok: false, error: v.errors.join('; ') });
  }

  const token = process.env.WAITLIST_SLACK_BOT_TOKEN || process.env.CONTACT_SLACK_BOT_TOKEN;
  const channel =
    process.env.SLACK_WAITLIST_CHANNEL
    || process.env.WAITLIST_SLACK_CHANNEL
    || process.env.CONTACT_SLACK_CHANNEL
    || 'C0ATRTVMCH1'; // HQ #acorn fallback
  if (!token) {
    if (asForm) {
      return respondFormError(res, 503, 'delivery channel is not configured on the server', backHref);
    }
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
    const detail = `delivery request failed: ${err && err.name === 'AbortError' ? 'timed out' : 'network error'}`;
    if (asForm) return respondFormError(res, 502, detail, backHref);
    return res.status(502).json({ ok: false, error: detail });
  }

  if (!slack || slack.ok !== true) {
    const detail = `delivery was not confirmed (${(slack && slack.error) || 'no response detail'})`;
    if (asForm) return respondFormError(res, 502, detail, backHref);
    return res.status(502).json({ ok: false, error: detail });
  }

  // Confirmed at the destination: Slack returned ok:true with a message ts. The
  // no-JS visitor gets the same thanks page the JS visitor gets, by redirect;
  // the fetch path gets the same JSON it always got.
  if (asForm) return respondFormSuccess(res);
  return res.status(200).json({ ok: true, ref: slack.ts });
}
