// ACR-833: shared contract between /api/reserve and /api/checkout.
//
// WHY THIS EXISTS. Both endpoints take the same form from the same page, and
// their validation MUST agree. If they drifted, a buyer could pass one and be
// rejected by the other for the same input, which on a payment page reads as
// the site being broken at the exact moment someone is trying to hand over
// money. The plan labels must agree for the same reason: the label written
// into #acorn and the label priced at checkout have to describe the same deal.
//
// Vercel does not treat files whose names begin with an underscore in /api as
// endpoints, so this module is importable but never routable.

// The founder-ruled plan labels (cos/decisions/
// 2026-07-15_founding-member-commercial-pack.md). These strings are what a
// human reads in #acorn, so they carry the terms rather than a bare code.
export const PLANS = {
  monthly: 'Founding Member, $2,500/mo (half of $5,000 retail, for life)',
  annual: 'Founding Member annual, $25,000/yr (10 months, 2 free)',
  undecided: 'Wants a Founding seat, plan not chosen yet',
};

export const MAX_NAME = 200;
export const MAX_EMAIL = 320;
export const MAX_COMPANY = 200;
export const MAX_NOTES = 2000;
export const MAX_SLUG = 200;

export async function readJsonBody(req) {
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

export function validateBuyer(body) {
  const errors = [];
  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim();
  const company = (body.company || '').toString().trim();
  const notes = (body.notes || '').toString().trim();
  const slug = (body.source_slug || '').toString().trim();
  const plan = (body.plan || '').toString().trim();
  // Acknowledgements: accept only a real affirmative. A missing or non-true
  // value is a non-acknowledgement, never assumed.
  const termsAck = body.terms_ack === true;
  const noChargeAck = body.no_charge_ack === true;

  if (!name) errors.push('name is required');
  if (name.length > MAX_NAME) errors.push('name is too long');
  if (!email) errors.push('email is required');
  else if (email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('email does not look like an email address');
  }
  if (!company) errors.push('company is required');
  if (company.length > MAX_COMPANY) errors.push('company is too long');
  if (notes.length > MAX_NOTES) errors.push('notes are too long');
  if (slug.length > MAX_SLUG) errors.push('source_slug is too long');
  if (!plan) errors.push('a plan choice is required');
  else if (!Object.prototype.hasOwnProperty.call(PLANS, plan)) {
    errors.push('plan is not one of the offered options');
  }
  if (!termsAck) errors.push('the Founding Member terms must be acknowledged');
  if (!noChargeAck) {
    errors.push('the acknowledgement that no payment is taken today is required');
  }

  return { errors, name, email, company, notes, slug, plan, termsAck, noChargeAck };
}

// Slack message text treats &, <, > as control characters (mrkdwn / <!channel>
// broadcasts, <url|label> links). Escape every buyer-supplied value so a field
// like a company name of "<!channel>" is shown literally, never fires a
// broadcast or spoofs a link. Per Slack's own escaping rules only these three
// need replacing, ampersand first.
export function slackEscape(v) {
  return (v || '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ACR-815: the founder is tagged on money-shaped events. The id defaults in
// code because an env var that must be set on Vercel would fail silently in
// exactly the case that matters.
export const FOUNDER_ID = () => process.env.RESERVE_NOTIFY_USER_ID || 'U0AU1SJGS92';

export function slackToken() {
  return process.env.RESERVE_SLACK_BOT_TOKEN || process.env.CONTACT_SLACK_BOT_TOKEN;
}

export function slackChannel() {
  return process.env.RESERVE_SLACK_CHANNEL || process.env.CONTACT_SLACK_CHANNEL || 'C0ATRTVMCH1'; // HQ #acorn
}

// Post to #acorn and report honestly what happened. Returns
// {ok, ts} or {ok:false, error}. Callers decide their own status codes; this
// never invents a reason for a failure it cannot see.
export async function postToSlack(text) {
  const token = slackToken();
  if (!token) return { ok: false, error: 'delivery channel is not configured on the server' };
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
        channel: slackChannel(),
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    slack = await resp.json();
  } catch (err) {
    return {
      ok: false,
      error: `delivery request failed: ${err && err.name === 'AbortError' ? 'timed out' : 'network error'}`,
    };
  }
  if (!slack || slack.ok !== true) {
    return { ok: false, error: `delivery was not confirmed (${(slack && slack.error) || 'no response detail'})` };
  }
  return { ok: true, ts: slack.ts };
}
