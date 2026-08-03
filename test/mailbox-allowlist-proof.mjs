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
// alpha@buyacorn.com: same invention pattern as waitlist@. Needs a founder
// ruling -- tracked on acorn-os #890.
const PENDING_FOUNDER_RULING = new Map([
  ['alpha@buyacorn.com', [
    ['api/alpha.js', 2],
    ['public/alpha/index.html', 1],
    ['public/annaleigh/index.html', 1],
    ['public/join/index.html', 1],
    ['public/tre/index.html', 1],
    // NOT public/static/alpha-submit.js: its two hits are inside the opening
    // block comment. A raw grep counts them; the scanner correctly does not,
    // and this list caught the difference on its first run.
  ]],
]);

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
// Pinned to file AND exact occurrence count, same as the quarantine list
// below: two occurrences in public/index.html would otherwise ride in free.
const EMBARGOED_UNTIL_RERENDER = new Map([
  ['waitlist@buyacorn.com', [
    ['public/index.html', 1],
    ['public/example/index.html', 1],
  ]],
]);

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
ok('the dead mailbox is not confirmed-real', !CONFIRMED_REAL.has(DEAD_MAILBOX));

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

// --- #890's specific pin ---------------------------------------------------
const embargoedFiles = new Set(
  (EMBARGOED_UNTIL_RERENDER.get(DEAD_MAILBOX) || []).map(([f]) => f));
const deadSites = sitesOf(DEAD_MAILBOX).filter((s) => !embargoedFiles.has(s.split(':')[0]));
ok(`${DEAD_MAILBOX} appears nowhere outside the embargoed pre-rendered HTML`,
  deadSites.length === 0, deadSites.join('; '));

// Deleting the address and leaving the sentence addressless would also pass
// everything above. Assert the ruled address is on the failure paths.
const brianFiles = new Set(filesOf('brian@buyacorn.com'));
ok('the JS failure path names brian@buyacorn.com', brianFiles.has('public/static/waitlist-submit.js'));
ok('the /api/waitlist error page names brian@buyacorn.com', brianFiles.has('api/waitlist.js'));

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
  console.log('address. Embargoed until acorn-os #887 merges:');
  for (const [addr, pins] of EMBARGOED_UNTIL_RERENDER) {
    for (const [file] of pins) console.log(`  ${file} still names ${addr}`);
  }
  console.log('Merge order: #887 -> #789 repin -> re-render buyacorn -> redeploy.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
