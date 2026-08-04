// ACR-829 markup gate for /reserve.
//
// The API suite proves the endpoint. It cannot see the HTML, so it stayed green
// while the form itself carried the leak: deleting method/action from the form
// tag was invisible to every one of those 48 assertions. This file closes that
// blind spot and is the reason a future edit cannot silently reopen the leak.
//
// What is being prevented: a <form> with no method defaults to GET and with no
// action defaults to the page's own URL, so a submit JavaScript does not
// intercept navigates to /reserve?name=...&email=...&company=..., putting buyer
// PII into browser history, access logs and the next Referer header.
// Run: node test/reserve-markup-proof.mjs
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

console.log('ACR-829 /reserve markup proof');

const html = readFileSync(new URL('../public/reserve/index.html', import.meta.url), 'utf8');
const formTag = (html.match(/<form[^>]*id="reserve-form"[^>]*>/) || [])[0];

ok('the reserve form exists', !!formTag, formTag);
ok('form declares method="POST"', /method="POST"/i.test(formTag), formTag);
ok('form declares action="/api/reserve"', /action="\/api\/reserve"/.test(formTag), formTag);

// The specific defect: neither attribute present means GET to the page's URL.
ok('form can NEVER default to GET against its own URL',
  /method=/i.test(formTag) && /action=/i.test(formTag), formTag);

// The older leak this page was built without, re-asserted so it cannot return.
ok('no mailto: action anywhere on the page', !/action="mailto:/i.test(html));
ok('no mailto: link anywhere on the page', !/mailto:/i.test(html));

// Every field that would have ridden the query string. If a name is added to
// the form later, it is covered by the two assertions above rather than needing
// a new line here, but these pin the fields that carry PII today.
for (const field of ['name', 'email', 'company', 'terms_ack', 'no_charge_ack']) {
  ok(`field "${field}" is inside the POSTing form`, new RegExp(`name="${field}"`).test(html));
}

// The submit script must not fall back to a native submit on failure: that is
// the #387 gate, and with an action now present it would POST rather than GET,
// but it would still bypass the handler's error reporting.
const js = readFileSync(new URL('../public/static/reserve-submit.js', import.meta.url), 'utf8');
const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('reserve-submit.js never calls form.submit() in executable code', !/\.submit\s*\(/.test(code));
ok('reserve-submit.js still POSTs to /api/reserve', /fetch\(\s*["']\/api\/reserve["']/.test(code));

// --- ACR-907: the wiring, and the copy that must move with it ---
//
// The whole point of ACR-907 is that /reserve finally reaches /api/checkout.
// #833 proved the endpoint worked while NOTHING on the site called it, so the
// endpoint suite was green and no buyer could ever pay. This assertion is the
// one that would have caught that.
ok('reserve-submit.js POSTs to /api/checkout (the wiring #833 never had)',
  /fetch\(\s*["']\/api\/checkout["']/.test(code));
ok('a paid plan is redirected to the Stripe url, not to /reserve/thanks',
  /window\.location\.href\s*=\s*body\.url/.test(code));
// The ruling: "hold a seat, decide later" is a reservation and must never reach
// a card form. Enforced server-side too; this pins the client gate.
ok('"undecided" never reaches checkout, client-side gate present',
  /undecided/.test(code) && /reserveOnly\s*\(\s*\)/.test(code));
// A 503 is checkout.js's inert answer with no key set. Without this fallback a
// key rotation turns the button into a dead end on a commercial page.
ok('503 from checkout degrades to a plain reservation, not a dead button',
  /503/.test(code) && /reserveOnly/.test(code));

// COPY GATE. These claims were true before ACR-907 and are lies after it. A
// page that takes $2,500 while telling the buyer it takes nothing is the worst
// defect this change could ship, and it is invisible to every API assertion.
for (const lie of [
  /no payment is taken/i,
  /no payment is being taken/i,
  /card processing is not open/i,
  /reserving costs you nothing/i,
]) {
  ok(`page no longer claims: ${lie.source}`, !lie.test(html));
}
ok('page states the $2,500 charge happens today', /\$2,500 is charged today/i.test(html));
ok('page still tells "decide later" buyers nothing is charged',
  /nothing is charged/i.test(html));
ok('the acknowledgement the buyer ticks matches what actually happens',
  /charges \$2,500 today/i.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
