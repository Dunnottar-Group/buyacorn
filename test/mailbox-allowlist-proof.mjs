// ACR-890 proof (acorn-os #890): no customer-facing page, script or API
// handler may name an @buyacorn.com address that is not a confirmed-real
// mailbox.
// Run: node test/mailbox-allowlist-proof.mjs
//
// The defect
// ----------
// The homepage waitlist fallback note, and the failure-path message in
// static/waitlist-submit.js, told a visitor whose submit had just failed to
// write to waitlist@buyacorn.com. That is not a mailbox. Founder ruling
// 2026-08-03, verbatim:
//
//     "waitlist@buyacorn.com -- not real, use brian@buyacorn.com"
//
// It fires only when something else already failed: the person does exactly
// what we told them to do and their message lands nowhere. No bounce anyone
// reads, no lead, no follow-up.
//
// Why a pattern gate
// ------------------
// waitlist@ was not a typo, it was INVENTED -- someone needed an address in
// a sentence and wrote a plausible one. alpha@buyacorn.com came from the
// same reflex, and #894 confirmed it: founder ruling 2026-08-03, verbatim,
// "use support@ instead of alpha@". Two invented addresses out of the four
// this repo has ever named is why the gate discovers addresses by pattern
// across the whole shipped surface and holds each to an allowlist, rather
// than pinning the one known-bad string and missing the next invention.
//
// What this proof does NOT establish: that support@buyacorn.com is
// deliverable. `dig MX buyacorn.com` returns Google Workspace MX records, so
// the DOMAIN accepts mail; whether the support@ local-part resolves to a
// real, monitored mailbox is unverified here and is the founder's to
// confirm. This file records a ruling, not a delivery test.
//
// Comments are stripped before scanning: an address inside a comment never
// reaches a visitor, and api/waitlist.js line 7 legitimately quotes the dead
// address while describing the #779 defect it documents.
//
// The stripper removes only the comment SPAN, never the whole line, and only
// when the comment opens the line. An adversarial review of the first draft
// (grok, 2026-08-03) broke the line-based version with three inputs that a
// scanner must never lose, each verified against the code before this
// rewrite landed:
//
//   /* fallback */ showError("write to support@buyacorn.com");   <- whole line dropped
//           * email support@buyacorn.com with your name          <- HTML bullet read as JSDoc
//   /* temporary          (unclosed)                             <- rest of file blanked
//
// The span rule keeps everything after `*/`, keeps everything before any
// marker, and never treats a bare `*` as a comment. A trailing `//` on a code
// line is deliberately NOT stripped: `"see https://x/ or foo@buyacorn.com"`
// would otherwise vanish. The scanner errs toward flagging, never hiding.

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Any local part, so an address nobody has thought of yet is still found.
const ADDRESS_RE = /[A-Za-z0-9._%+-]+@buyacorn\.com/gi;

// Mailboxes confirmed real and deliberately used in customer copy. Adding to
// this set is a claim that a human reads that inbox. Do not add an address
// here to make this proof green; get the ruling first.
const CONFIRMED_REAL = new Set([
  'brian@buyacorn.com', // founder ruling 2026-08-03 (#890)
  'hello@buyacorn.com', // ACR-778 ruling: /status and /reserve
  'support@buyacorn.com', // founder ruling 2026-08-03 (#894)
]);

// Live in customer copy today, NOT ruled on. QUARANTINE, NOT BLESSING -- and
// that distinction has to be enforced, not asserted. The first draft of this
// file held a bare set of addresses, which the invariant then skipped
// everywhere; an adversarial review (grok, 2026-08-03) pointed out that this
// is an allowlist entry wearing a quarantine label, because a SIXTH page
// could start naming alpha@ and nothing would go red.
//
// So each entry pins file -> exact occurrence count. A new use of an
// unconfirmed address, in any file, fails. Removing a use fails too, which is
// the point: the list has to be maintained down to zero, not left standing.
//
// EMPTY AS OF #894. alpha@buyacorn.com was the only entry. acorn-os #894
// asked whether it was real and the founder ruled 2026-08-03, verbatim:
//
//     "use support@ instead of alpha@"
//
// A ruled address does not stay in quarantine: it goes to CONFIRMED_REAL if
// it is real, or to DEAD_MAILBOXES if it is not. alpha@ went to
// DEAD_MAILBOXES, and its one buyacorn-only use -- the mailto in the
// /api/alpha error page -- now names support@. Empty is the correct resting
// state for this list.
const PENDING_FOUNDER_RULING = new Map([]);

// THE EMBARGO. Some addresses live only in PRE-RENDERED public/*.html, which
// this repo does not author: acorn-os's site/templates own that copy and
// buyacorn receives it by re-render. So a template fix in acorn-os and the
// HTML fix here cannot land in the same commit, and the window between them
// is a real state the proof has to describe rather than hide.
//
// #890's waitlist@ entries are GONE from this list because that re-render
// landed (PR #23, merged 2026-08-03): the stale-entry check below went red on
// main the moment it did, which is exactly what it is for, and deleting them
// here is the cleanup that check demanded.
//
// #894's alpha@ entries take their place. The four alpha-funnel pages below
// are still rendered from the PRE-#894 templates. The acorn-os template fix
// is a separate PR; until the NEXT re-render carries it, the live HTML says
// alpha@ while the /api/alpha error page says support@. That mixed state is
// deliberate, and it is the safe direction: the API error page is what a
// person sees at the exact moment their application failed, it ships without
// a re-render, and it is now correct.
//
// Each entry MUST still be present, and the check below fails when one goes
// missing. That is on purpose: after the re-render these entries are stale,
// and a stale exception is a standing pre-approval to bring the address back
// that nobody would ever review. The failing message says to delete them.
// Pinned to file AND exact occurrence count: two occurrences in
// public/alpha/index.html would otherwise ride in free.
const EMBARGOED_UNTIL_RERENDER = new Map([
  ['alpha@buyacorn.com', [
    ['public/alpha/index.html', 1],
    ['public/annaleigh/index.html', 1],
    ['public/join/index.html', 1],
    ['public/tre/index.html', 1],
    // NOT public/static/alpha-submit.js: its two hits are inside the opening
    // block comment, describing the #387/#825 mailto leak in the past tense.
    // A raw grep counts them; the scanner correctly does not, and this list
    // caught the difference on its first run.
  ]],
]);

// Addresses a founder ruled are not real. Pinned to zero everywhere except
// the embargo window above. Removing one is a claim the mailbox came back.
const DEAD_MAILBOXES = [
  'waitlist@buyacorn.com', // founder ruling 2026-08-03 (#890)
  'alpha@buyacorn.com',    // founder ruling 2026-08-03 (#894)
];

// Customer-facing surface. Directories are WALKED, never listed file by file:
// a new page with a new invented address must fail with no test naming it.
const SCAN_DIRS = ['public', 'api', 'src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.git', 'archive', 'test']);
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.xml', '.svg', '.astro']);

// A floor, so a repo that stops shipping these cannot make this vacuously
// green. Discovery is the real gate.
const KNOWN_ADDRESS_BEARING_FILES = [
  // ACR-991 moved the rendered offer page off the site root: at public/index.html
  // it was shadowing Brian's src/pages/index.astro in the Astro build, so
  // buyacorn.com/ served this page instead of the real homepage. Same file,
  // same waitlist form, same brian@ fallback address, now at /offer.
  'public/offer/index.html',
  'public/static/waitlist-submit.js',
  'api/waitlist.js',
  'api/alpha.js', // #894: the alpha failure path must never go addressless
];

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log(`ok   ${label}`); }
  else { fail += 1; console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ''}`); }
}

// Removes leading comment SPANS only. Everything else survives, including
// every character after a closing `*/` or `-->` on the same line.
function stripComments(text) {
  const out = [];
  let closer = null; // '*/' or '-->' while a block comment is open
  for (const line of text.split('\n')) {
    let rest = line;
    for (;;) {
      if (closer) {
        const end = rest.indexOf(closer);
        if (end < 0) { rest = ''; break; }        // still inside the comment
        rest = rest.slice(end + closer.length);   // KEEP what follows the close
        closer = null;
        continue;
      }
      const t = rest.trimStart();
      if (t.startsWith('//')) { rest = ''; break; }   // rest of line is comment
      if (t.startsWith('/*')) {
        rest = t.slice(2); closer = '*/'; continue;
      }
      if (t.startsWith('<!--')) {
        rest = t.slice(4); closer = '-->'; continue;
      }
      break; // real content: leave the whole line alone
    }
    out.push(rest);
  }
  // A block comment that never closes would blank the rest of the file and
  // hide every address in it. An unclosed comment is a broken file, not a
  // licence to stop scanning: fall back to the raw text so the scanner sees
  // everything.
  if (closer) return text;
  return out.join('\n');
}

// --- verify the verifier ---------------------------------------------------
// The stripper is the one component that can make this whole proof lie: it
// decides what the scanner never sees. These are the three inputs that broke
// the first draft, run on every invocation so a future "simplification" of
// stripComments cannot quietly reopen the hole. Each must SURVIVE stripping.
const STRIPPER_MUST_NOT_HIDE = [
  ['code after a same-line block comment',
    '  /* fallback */ showError("write to support@buyacorn.com and we will add you");'],
  ['visible line that merely starts with an asterisk',
    '        * email support@buyacorn.com with your name'],
  ['unclosed block comment blanking the rest of the file',
    '/* temporary\nshowError("write to support@buyacorn.com");'],
  ['address after a closing --> on the same line',
    '<!-- note --> <p>email support@buyacorn.com</p>'],
  ['trailing // comment on a code line',
    '  showError("write to support@buyacorn.com"); // note'],
];
for (const [label, input] of STRIPPER_MUST_NOT_HIDE) {
  ok(`stripper does not hide: ${label}`,
    /support@buyacorn\.com/i.test(stripComments(input)),
    `stripComments() removed a visitor-visible address:\n     ${JSON.stringify(input)}`);
}
// ...and it must still do its actual job, or api/waitlist.js's historical
// comment would be a permanent false positive.
ok('stripper does remove a genuine full-line comment',
  !/support@buyacorn\.com/i.test(stripComments('// email support@buyacorn.com')));
ok('stripper does remove a genuine block comment',
  !/support@buyacorn\.com/i.test(stripComments('/*\n * email support@buyacorn.com\n */')));

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(full); continue; }
    const dot = e.name.lastIndexOf('.');
    if (dot < 0 || !TEXT_EXT.has(e.name.slice(dot))) continue;
    yield full;
  }
}


// address -> Map(relpath -> ["relpath:lineno", ...]). Lowercased: Brian@ and
// brian@ are one mailbox (src/pages/contact.astro ships the capitalised form).
const found = new Map();
let filesScanned = 0;
for (const dir of SCAN_DIRS) {
  for await (const full of walk(join(ROOT, dir))) {
    filesScanned += 1;
    const rel = relative(ROOT, full);
    const text = stripComments(await readFile(full, 'utf8'));
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(ADDRESS_RE)) {
        const addr = m[0].toLowerCase();
        if (!found.has(addr)) found.set(addr, new Map());
        const byFile = found.get(addr);
        if (!byFile.has(rel)) byFile.set(rel, []);
        byFile.get(rel).push(`${rel}:${i + 1}`);
      }
    });
  }
}

const sitesOf = (addr) => [...(found.get(addr) || new Map()).values()].flat();
const filesOf = (addr) => [...(found.get(addr) || new Map()).keys()];
const countIn = (addr, file) => ((found.get(addr) || new Map()).get(file) || []).length;

// Every (address, file, count) triple this proof tolerates, from both
// exception lists. Anything else is an offender.
const TOLERATED = new Map();
for (const src of [PENDING_FOUNDER_RULING, EMBARGOED_UNTIL_RERENDER]) {
  for (const [addr, pins] of src) {
    if (!TOLERATED.has(addr)) TOLERATED.set(addr, new Map());
    for (const [file, count] of pins) TOLERATED.get(addr).set(file, count);
  }
}

// --- coherence -------------------------------------------------------------
const overlap = [...TOLERATED.keys()].filter((a) => CONFIRMED_REAL.has(a));
ok('no address is both confirmed-real and held under an exception',
  overlap.length === 0, overlap.join(', '));
for (const dead of DEAD_MAILBOXES) {
  ok(`the dead mailbox ${dead} is not confirmed-real`, !CONFIRMED_REAL.has(dead));
  ok(`the dead mailbox ${dead} is not sitting in the pending-ruling list`,
    !PENDING_FOUNDER_RULING.has(dead),
    'quarantine is for an address awaiting a ruling; once ruled the entry must go');
}
ok('the address #894 ruled onto the failure path is confirmed-real',
  CONFIRMED_REAL.has('support@buyacorn.com'));

// --- discovery is not vacuous ---------------------------------------------
ok(`scanner read files (${filesScanned})`, filesScanned > 0);
ok('scanner found @buyacorn.com addresses', found.size > 0);
for (const f of KNOWN_ADDRESS_BEARING_FILES) {
  const bearing = [...found.values()].some((byFile) => byFile.has(f));
  ok(`still shipping ${f} and it still names an address`, bearing);
}

// --- THE INVARIANT ---------------------------------------------------------
// Confirmed-real addresses go anywhere. Everything else is allowed only in
// the exact files, and at the exact counts, the exception lists pin. A sixth
// page naming alpha@, or a second waitlist@ inside an embargoed page, fails.
const offenders = [];
for (const [addr, byFile] of found) {
  if (CONFIRMED_REAL.has(addr)) continue;
  const pins = TOLERATED.get(addr) || new Map();
  for (const [file, sites] of byFile) {
    const allowed = pins.get(file) || 0;
    if (sites.length > allowed) {
      offenders.push(`${addr} x${sites.length} in ${file} (pinned: ${allowed}) at ${sites.join(', ')}`);
    }
  }
}
ok('no customer-facing file names an unconfirmed address beyond its pinned occurrences',
  offenders.length === 0,
  `${offenders.join('; ')}\n     If one of these is a real mailbox, get the founder ruling and add it to CONFIRMED_REAL. Do not add it to make this green.`);

// --- #890's and #894's specific pins ---------------------------------------
for (const dead of DEAD_MAILBOXES) {
  const embargoedFiles = new Set(
    (EMBARGOED_UNTIL_RERENDER.get(dead) || []).map(([f]) => f));
  const deadSites = sitesOf(dead).filter((s) => !embargoedFiles.has(s.split(':')[0]));
  ok(`${dead} appears nowhere outside the embargoed pre-rendered HTML`,
    deadSites.length === 0, deadSites.join('; '));
}

// Deleting the address and leaving the sentence addressless would also pass
// everything above. Assert the ruled address is on the failure paths -- the
// screens a person actually reaches when their submit has just failed.
const brianFiles = new Set(filesOf('brian@buyacorn.com'));
ok('the JS failure path names brian@buyacorn.com', brianFiles.has('public/static/waitlist-submit.js'));
ok('the /api/waitlist error page names brian@buyacorn.com', brianFiles.has('api/waitlist.js'));
const supportFiles = new Set(filesOf('support@buyacorn.com'));
ok('the /api/alpha error page names support@buyacorn.com', supportFiles.has('api/alpha.js'),
  'this is the page a rejected alpha applicant sees at the moment their application failed; '
  + 'it ships without a re-render, so it must never be the one left pointing at a dead mailbox');

// An adversarial review (grok, 2026-08-03) pointed out that the check above is
// satisfied by ANY support@ anywhere in the file, so `mailto:us@...` with
// support@ buried in a comment-free string elsewhere would pass. The applicant
// clicks the href; assert the href itself.
const alphaApiSource = await readFile(join(ROOT, 'api/alpha.js'), 'utf8');
ok('the /api/alpha error page mailto: href points at support@buyacorn.com',
  /href="mailto:support@buyacorn\.com"/.test(alphaApiSource),
  'the visible link text is not the part the browser follows');

// --- every fallback note names a mailbox somebody reads --------------------
// grok, same review: nothing here required the PUBLIC alpha pages to name the
// ruled address once the embargo lifts. A re-render that put any
// confirmed-real address in the note -- brian@, hello@ -- would have gone
// green, and the founder ruling would be enforced only in acorn-os.
//
// Both rules below read the NOTE ELEMENT, not the page: an address in a
// footer is not a recovery route for someone whose submit just failed.
// Pages are DISCOVERED by the note element, never listed: members.json mints
// one referral page per active partner, and each must be gated on arrival.
const NOTE_RE = /<p[^>]*class="form-fallback-note"[^>]*>([\s\S]*?)<\/p>/g;
// The alpha/referral fallback wording, shared with the acorn-os template gate
// (tests/site_launch/test_acr890_no_invented_mailboxes.py).
const ALPHA_FALLBACK_SENTENCE = 'If this form does not go through, email us at';

const embargoedFileSet = new Set();
for (const [, pins] of EMBARGOED_UNTIL_RERENDER) {
  for (const [file] of pins) embargoedFileSet.add(file);
}

const noteless = [];
const notRuled = [];
let notesSeen = 0;
for await (const full of walk(join(ROOT, 'public'))) {
  if (!full.endsWith('.html')) continue;
  const rel = relative(ROOT, full);
  const html = await readFile(full, 'utf8');
  for (const m of html.matchAll(NOTE_RE)) {
    notesSeen += 1;
    const note = m[1];
    const addrs = (note.match(ADDRESS_RE) || []).map((a) => a.toLowerCase());
    // The embargo window: these pages are pre-#894 renders and are already
    // pinned above. Once those pins are deleted, both rules bind here.
    if (embargoedFileSet.has(rel)) continue;
    if (!addrs.some((a) => CONFIRMED_REAL.has(a))) {
      noteless.push(`${rel}: note names ${addrs.length ? addrs.join(', ') : 'no address'}`);
    }
    if (note.includes(ALPHA_FALLBACK_SENTENCE)
      && !addrs.includes('support@buyacorn.com')) {
      notRuled.push(`${rel}: alpha-funnel note names ${addrs.join(', ') || 'no address'}`);
    }
  }
}
ok(`fallback notes discovered (${notesSeen})`, notesSeen > 0,
  'no form-fallback-note found in public/ -- this rule would pass vacuously');
ok('every fallback note names a confirmed-real mailbox',
  noteless.length === 0,
  `${noteless.join('; ')}\n     A visitor whose submit just failed is told to email someone. `
  + 'It has to be someone who reads it.');
ok('every alpha-funnel fallback note names the address #894 ruled',
  notRuled.length === 0,
  `${notRuled.join('; ')}\n     Founder ruling 2026-08-03 (#894): "use support@ instead of alpha@".`);

// --- neither exception list may go stale ----------------------------------
for (const [label, src, note] of [
  ['embargo', EMBARGOED_UNTIL_RERENDER,
    'the re-render has landed. DELETE this entry; leaving it pre-approves bringing the dead address back.'],
  ['pending-ruling', PENDING_FOUNDER_RULING,
    'this use is gone. DELETE this entry; leaving it pre-approves re-introducing an unruled address.'],
]) {
  for (const [addr, pins] of src) {
    for (const [file, count] of pins) {
      const actual = countIn(addr, file);
      ok(`${label} entry still applies: ${addr} x${count} in ${file}`,
        actual === count, `found ${actual} -- ${note}`);
    }
  }
}

// The embargo is a KNOWN green-with-dead-copy window, not a clean bill of
// health. Say so on every run, so nobody reads "0 failed" as "the live site
// is clean".
if (EMBARGOED_UNTIL_RERENDER.size) {
  console.log('\nNOTE: this proof is green WHILE the live pre-rendered HTML still shows a dead');
  console.log('address. These pages are rendered from acorn-os templates, and the acorn-os');
  console.log('fix for #894 is a separate PR, so they change only on the NEXT re-render:');
  for (const [addr, pins] of EMBARGOED_UNTIL_RERENDER) {
    for (const [file] of pins) console.log(`  ${file} still names ${addr}`);
  }
  console.log('Sequence: merge the acorn-os #894 PR -> re-render buyacorn public/ ->');
  console.log('delete the entries above (this proof goes red until you do) -> redeploy.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
