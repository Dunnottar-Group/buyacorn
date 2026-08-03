// ACR-825 proof: no alpha application page in this repo may carry a
// `mailto:` action, in public/ or in the built dist/.
// Run: node test/alpha-markup-proof.mjs [--dist]
//
// WHY THIS FILE EXISTS
// --------------------
// Issue #387 removed the JS half of the /alpha PII leak: the `form.submit()`
// call in static/alpha-submit.js that fell through to the form's own action
// on a failed fetch. It left `action="mailto:alpha@buyacorn.com"` on the form
// itself. That attribute is the browser's NATIVE no-JS submit path and needs
// no JavaScript to fire at all, so an applicant with JS disabled -- or one
// whose browser simply failed to load /static/alpha-submit.js -- pressed
// "Apply for the alpha" and the browser serialized name, email, company AND
// the three consent checkboxes into a mail compose window as visible
// x-www-form-urlencoded text. Confirmed live on production 2026-08-03 on
// /alpha, /join, /tre and /annaleigh.
//
// THE RE-RENDER HAZARD THIS SPECIFICALLY GUARDS
// ---------------------------------------------
// These pages are NOT hand-written here. They are pre-rendered output of
// acorn-os `site/build.py` (templates/alpha_body.html.tmpl -> /alpha,
// templates/referral_body.html.tmpl -> /join and every referral partner
// slug). A fix applied only in this repo is undone by the next sync from
// acorn-os. That is exactly how #776's region pin was lost. The paired
// acorn-os PR fixes the templates and carries the matching Python gate
// (tests/site_launch/test_acr825_alpha_no_mailto.py); this file is the
// catch on THIS side of the boundary, so a bad sync fails here too.
//
// The page list is DISCOVERED, not hardcoded: any file carrying
// id="alpha-form" is held to the rule. A newly seeded referral partner in
// acorn-os mints a brand new public page, and it must not arrive untested.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALPHA_FORM_MARKER = 'id="alpha-form"';

// The pages that carried the defect when #825 was filed. Discovery below is
// the real gate; this is a floor, so a tree that stops containing these pages
// cannot make the proof vacuously green.
const KNOWN_ALPHA_PAGES = [
  'alpha/index.html',
  'join/index.html',
  'tre/index.html',
  'annaleigh/index.html',
];

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

function walkHtml(root) {
  const out = [];
  (function rec(dir) {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) rec(full);
      else if (entry.endsWith('.html')) out.push(full);
    }
  })(root);
  return out;
}

function alphaFormPages(root) {
  return walkHtml(root)
    .filter((f) => readFileSync(f, 'utf8').includes(ALPHA_FORM_MARKER))
    .map((f) => relative(root, f).split(/[\\/]/).join('/'))
    .sort();
}

function checkTree(label, root) {
  console.log(`\n-- ${label} (${root})`);
  const pages = alphaFormPages(root);

  // A gate that matches nothing proves nothing.
  ok(`${label}: discovery finds alpha form pages`, pages.length > 0, `found ${pages.length}`);
  const missing = KNOWN_ALPHA_PAGES.filter((p) => !pages.includes(p));
  ok(`${label}: covers every page named in #825`, missing.length === 0, `missing ${JSON.stringify(missing)}`);
  console.log(`     discovered: ${JSON.stringify(pages)}`);

  for (const rel of pages) {
    const html = readFileSync(join(root, rel), 'utf8');

    // 1. No mailto ANYWHERE on an application page. A mailto link on one of
    //    these pages is either this defect or a new one wearing the same
    //    clothes: the rule for these pages is a plain address, never a
    //    scheme the browser can hand form fields to.
    const mailtos = html.match(/mailto:[^"'\s<>]*/g) || [];
    ok(`${rel}: no mailto: anywhere`, mailtos.length === 0, JSON.stringify(mailtos));

    // 2. The form tag itself carries no action and no method. `action` is
    //    the leak; `method` goes with it because a POST form with no action
    //    re-posts to the page's own URL, which is not a transport this
    //    static site has. static/alpha-submit.js calls preventDefault() and
    //    owns the submit outright.
    const tags = html.match(/<form[^>]*\bid="alpha-form"[^>]*>/g) || [];
    ok(`${rel}: exactly one alpha form`, tags.length === 1, `got ${tags.length}`);
    if (tags.length === 1) {
      ok(`${rel}: form has no action=`, !tags[0].includes('action='), tags[0]);
      ok(`${rel}: form has no method=`, !tags[0].includes('method='), tags[0]);
    }

    // 3. The no-JS applicant is not stranded. Removing the action without
    //    leaving a route would be its own defect.
    ok(`${rel}: keeps a plain-text no-JS route`,
      html.includes('class="form-fallback-note"') &&
      html.includes('alpha@buyacorn.com') &&
      html.includes('JavaScript'));
  }
}

// 4. The JS may DESCRIBE the removed mailto path in its header comment (it
//    does, deliberately, so the next reader knows why the action is gone).
//    It must never reference one in executable code, and it must never call
//    form.submit() again -- #387's gate, restated because #387 and #825 are
//    two halves of one leak and they should fail together.
function checkJs(label, path) {
  console.log(`\n-- ${label} (${path})`);
  const src = readFileSync(path, 'utf8');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  ok(`${label}: no mailto: in executable code`, !codeOnly.includes('mailto:'));
  ok(`${label}: never calls form.submit()`, !codeOnly.includes('form.submit('));
  ok(`${label}: still POSTs to /api/alpha`, src.includes('/api/alpha'));
  ok(`${label}: still redirects to /alpha/thanks`, src.includes('/alpha/thanks'));
}

console.log('ACR-825 alpha form markup proof');

checkTree('public', join(REPO_ROOT, 'public'));
checkJs('public/static/alpha-submit.js', join(REPO_ROOT, 'public/static/alpha-submit.js'));

// dist/ is a build artifact and is gitignored, so it is only checked when it
// exists (pass --dist to require it, which is what the PR proof run does).
const distRoot = join(REPO_ROOT, 'dist');
const requireDist = process.argv.includes('--dist');
if (existsSync(distRoot)) {
  checkTree('dist', distRoot);
  checkJs('dist/static/alpha-submit.js', join(distRoot, 'static/alpha-submit.js'));
} else if (requireDist) {
  ok('dist/ present (--dist given)', false, 'run `npx astro build` first');
} else {
  console.log('\n-- dist/ absent, skipped (run `npx astro build`, then re-run with --dist)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
