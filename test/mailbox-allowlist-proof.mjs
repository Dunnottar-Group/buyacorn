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
// same reflex and is still unconfirmed. So this walks the whole shipped
// surface and holds every address it finds to an allowlist, rather than
// pinning the one known-bad string and missing the next invention.
//
// Comments are stripped before scanning: an address inside a comment never
// reaches a visitor, and api/waitlist.js line 7 legitimately quotes the dead
// address while describing the #779 defect it documents. Only FULL-LINE
// comments are stripped, deliberately -- a trailing comment on a code line
// is left in, so the scanner errs toward flagging, never toward hiding.

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
]);

// Live in customer copy today, NOT ruled on. Quarantine, not blessing.
// alpha@buyacorn.com is on /alpha, /join and every referral partner page and
// in api/alpha.js's failure page. Same invention pattern as waitlist@.
const PENDING_FOUNDER_RULING = new Set(['alpha@buyacorn.com']);

// THE EMBARGO (acorn-os #887). buyacorn must not be re-rendered until #887
// merges: acorn-os's alpha_thanks_body.html.tmpl still carries the false "we
// just sent your setup link" claim, and a re-render would push it live over
// the correct copy. So the two PRE-RENDERED pages below still show the dead
// address, while the JS failure path already shows the correct one. That
// mixed state is deliberate and is safer than an early re-render.
//
// Merge order: #887 -> #789 repin -> re-render buyacorn (which carries the
// template fix) -> redeploy.
//
// Each entry MUST still be present, and the check below fails when one goes
// missing. That is on purpose: after the re-render these entries are stale,
// and a stale exception is a standing pre-approval to bring the address back
// that nobody would ever review. The failing message says to delete them.
const EMBARGOED_UNTIL_RERENDER = [
  ['public/index.html', 'waitlist@buyacorn.com'],
  ['public/example/index.html', 'waitlist@buyacorn.com'],
];

const DEAD_MAILBOX = 'waitlist@buyacorn.com';

// Customer-facing surface. Directories are WALKED, never listed file by file:
// a new page with a new invented address must fail with no test naming it.
const SCAN_DIRS = ['public', 'api', 'src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.git', 'archive', 'test']);
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.xml', '.svg', '.astro']);

// A floor, so a repo that stops shipping these cannot make this vacuously
// green. Discovery is the real gate.
const KNOWN_ADDRESS_BEARING_FILES = [
  'public/index.html',
  'public/static/waitlist-submit.js',
  'api/waitlist.js',
];

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log(`ok   ${label}`); }
  else { fail += 1; console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ''}`); }
}

function stripFullLineComments(text) {
  const out = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; out.push(''); continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; out.push(''); continue; }
    if (t.startsWith('//') || t.startsWith('*') || (t.startsWith('<!--') && t.endsWith('-->'))) {
      out.push(''); continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

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

// address -> ["relpath:lineno", ...]. Lowercased: Brian@ and brian@ are one
// mailbox (src/pages/contact.astro ships the capitalised form).
const found = new Map();
let filesScanned = 0;
for (const dir of SCAN_DIRS) {
  for await (const full of walk(join(ROOT, dir))) {
    filesScanned += 1;
    const rel = relative(ROOT, full);
    const text = stripFullLineComments(await readFile(full, 'utf8'));
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(ADDRESS_RE)) {
        const addr = m[0].toLowerCase();
        if (!found.has(addr)) found.set(addr, []);
        found.get(addr).push(`${rel}:${i + 1}`);
      }
    });
  }
}

// --- coherence -------------------------------------------------------------
const overlap = [...PENDING_FOUNDER_RULING].filter((a) => CONFIRMED_REAL.has(a));
ok('no address is both confirmed-real and pending a ruling', overlap.length === 0, overlap.join(', '));
ok('the dead mailbox is not allowlisted',
  !CONFIRMED_REAL.has(DEAD_MAILBOX) && !PENDING_FOUNDER_RULING.has(DEAD_MAILBOX));

// --- discovery is not vacuous ---------------------------------------------
ok(`scanner read files (${filesScanned})`, filesScanned > 0);
ok('scanner found @buyacorn.com addresses', found.size > 0);
const bearing = new Set([...found.values()].flat().map((s) => s.split(':')[0]));
for (const f of KNOWN_ADDRESS_BEARING_FILES) {
  ok(`still shipping ${f} and it still names an address`, bearing.has(f));
}

// --- THE INVARIANT ---------------------------------------------------------
const embargoedAddrs = new Set(EMBARGOED_UNTIL_RERENDER.map(([, a]) => a));
const embargoedSites = new Set(EMBARGOED_UNTIL_RERENDER.map(([f, a]) => `${f}|${a}`));
const offenders = [];
for (const [addr, sites] of found) {
  if (CONFIRMED_REAL.has(addr) || PENDING_FOUNDER_RULING.has(addr)) continue;
  for (const site of sites) {
    const file = site.split(':')[0];
    if (embargoedAddrs.has(addr) && embargoedSites.has(`${file}|${addr}`)) continue;
    offenders.push(`${addr} at ${site}`);
  }
}
ok('no customer-facing file names an address outside the allowlist',
  offenders.length === 0,
  `${offenders.join('; ')}\n     If one of these is a real mailbox, get the founder ruling and add it to CONFIRMED_REAL. Do not add it to make this green.`);

// --- #890's specific pin ---------------------------------------------------
const deadSites = (found.get(DEAD_MAILBOX) || []).filter(
  (s) => !embargoedSites.has(`${s.split(':')[0]}|${DEAD_MAILBOX}`));
ok(`${DEAD_MAILBOX} appears nowhere outside the embargoed pre-rendered HTML`,
  deadSites.length === 0, deadSites.join('; '));

// Deleting the address and leaving the sentence addressless would also pass
// everything above. Assert the ruled address is on the failure paths.
const brianFiles = new Set((found.get('brian@buyacorn.com') || []).map((s) => s.split(':')[0]));
ok('the JS failure path names brian@buyacorn.com', brianFiles.has('public/static/waitlist-submit.js'));
ok('the /api/waitlist error page names brian@buyacorn.com', brianFiles.has('api/waitlist.js'));

// --- the embargo list cannot go stale -------------------------------------
for (const [file, addr] of EMBARGOED_UNTIL_RERENDER) {
  const still = (found.get(addr) || []).some((s) => s.split(':')[0] === file);
  ok(`embargo entry still applies: ${addr} in ${file}`, still,
    `${file} no longer names ${addr} -- the re-render has landed. DELETE this entry from EMBARGOED_UNTIL_RERENDER; leaving it pre-approves bringing the dead address back.`);
}

// --- the quarantine list cannot go stale ----------------------------------
for (const addr of PENDING_FOUNDER_RULING) {
  ok(`pending-ruling entry still applies: ${addr}`, found.has(addr),
    `${addr} is no longer in customer copy -- remove it from PENDING_FOUNDER_RULING.`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
