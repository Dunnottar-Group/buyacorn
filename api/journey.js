// Best-effort Acorn onboarding/support signal ingest.
//
// public/static/status.js emits fire-and-forget beacons to /api/journey as a
// visitor moves through setup. This endpoint makes those beacons real and posts
// non-sensitive setup/support signals into HQ #acorn. It deliberately does not
// forward setup tokens or email addresses to Slack.

const MAX_STAGE = 120;
const MAX_EVENT = 80;
const MAX_URL = 500;
const MAX_CONTEXT = 200;
const DEFAULT_CHANNEL = 'C0ATRTVMCH1'; // HQ #acorn

async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function respond(res, status, body) {
  res.status(status);
  return res.json(body);
}

function slackEscape(v) {
  return (v === undefined || v === null ? '' : String(v))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function trim(v, max) {
  return (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
}

function cleanPage(v) {
  const page = trim(v, MAX_URL);
  return page.split(/[?#]/)[0];
}

function normalize(body) {
  const stageId = trim(body.stage_id, MAX_STAGE);
  const eventType = trim(body.event_type || (stageId ? 'stage_signal' : ''), MAX_EVENT);
  const page = cleanPage(body.page);
  const currentStep = trim(body.current_step, MAX_CONTEXT);
  const supportFor = trim(body.support_for, MAX_CONTEXT);
  const ts = trim(body.ts, 80) || new Date().toISOString();

  const errors = [];
  if (!eventType) errors.push('event_type or stage_id is required');
  if (stageId && !/^[a-zA-Z0-9_.:-]+$/.test(stageId)) {
    errors.push('stage_id contains unsupported characters');
  }
  return { errors, stageId, eventType, page, currentStep, supportFor, ts };
}

function messageFor(v) {
  const label = {
    stage_signal: ':round_pushpin: *Setup progress signal*',
    support_requested: ':raising_hand: *Setup support requested*',
    setup_link_requested: ':link: *Setup link requested*',
  }[v.eventType] || ':round_pushpin: *Website journey signal*';

  const lines = [
    `${label} (buyacorn.com /status)`,
    `*Event:* ${slackEscape(v.eventType)}`,
    `*Received:* ${slackEscape(v.ts)} (client time)`,
  ];
  if (v.stageId) lines.push(`*Stage:* ${slackEscape(v.stageId)}`);
  if (v.currentStep) lines.push(`*Current step:* ${slackEscape(v.currentStep)}`);
  if (v.supportFor) lines.push(`*Support context:* ${slackEscape(v.supportFor)}`);
  if (v.page) lines.push(`*Page:* ${slackEscape(v.page)}`);
  return lines.join('\n');
}

async function postToSlack(text) {
  const token = process.env.JOURNEY_SLACK_BOT_TOKEN || process.env.CONTACT_SLACK_BOT_TOKEN;
  const channel =
    process.env.JOURNEY_SLACK_CHANNEL || process.env.CONTACT_SLACK_CHANNEL || DEFAULT_CHANNEL;
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
      body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respond(res, 405, { ok: false, error: 'method not allowed' });
  }

  let body;
  try {
    const raw = await readRawBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return respond(res, 400, { ok: false, error: 'request body was not valid JSON' });
  }

  const v = normalize(body);
  if (v.errors.length > 0) return respond(res, 400, { ok: false, error: v.errors.join('; ') });

  const delivered = await postToSlack(messageFor(v));
  if (!delivered.ok) return respond(res, 503, { ok: false, error: delivered.error });
  return respond(res, 200, { ok: true, ref: delivered.ts });
}
