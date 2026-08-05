// ACR-991 proof: no file in public/ may shadow a route generated from
// src/pages/. Run: node test/homepage-ownership-proof.mjs [--dist]
//
// WHY THIS FILE EXISTS
// --------------------
// buyacorn is an Astro site. Brian's hand-built homepage is
// src/pages/index.astro (74 KB of his own markup, copy and CSS). Astro copies
// public/ verbatim OVER its generated routes, so a static file at the same
// path silently wins and the .astro page is never rendered at all.
//
// On 2026-07-31 commit 392e335 added a machine-rendered public/index.html to
// this repo. From the next build on, buyacorn.com/ served the rendered
// Founding Member offer page and Brian's homepage stopped existing on the
// internet. Nothing was deleted and nothing errored: main still contained
// index.astro the whole time. Astro reported it, once, as a WARN in the
// middle of a green build:
//
//   [WARN] [build] Skipping src/pages/index.astro because a file with the
//   same name exists in the public folder: index.html
//
// Five days of production ran that way before the founder noticed by eye.
// BUILD_RC was 0 every time. That is the whole reason this is a test and not
// a comment: the failure mode is a silent, exit-0 substitution.
//
// THE RE-RENDER HAZARD THIS SPECIFICALLY GUARDS
// ---------------------------------------------
// public/ is not hand-written here. It is pre-rendered output synced from
// acorn-os site/build.py, whose line 856 is `write("index.html", ...)`. That
// is CORRECT for acorn-os's own standalone bundle, where / really is the
// offer page, and WRONG for this repo, which has a real homepage at /. So
// every future sync re-creates the collision unless something here refuses
// it. Fixing it only in acorn-os would leave this repo trusting the sync to
// keep behaving, which is the same bet that lost #776's region pin.
//
// DENY BY DEFAULT
// ---------------
// The rule is not "public/index.html is banned". A named-file blocklist loses
// to the next filename: the day someone adds src/pages/pricing.astro, a
// synced public/pricing/index.html shadows that too, in silence, exactly the
// same way. So the check derives the forbidden set from src/pages/ on every
// run and denies the whole class.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES_DIR = join(REPO_ROOT, 'src/pages');
const PUBLIC_DIR = join(REPO_ROOT, 'public');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// Every .astro page in src/pages, as its built route name. index.astro -> ''
// (the site root), welcome.astro -> 'welcome'. Nested dirs are handled the
// same way so this keeps working if src/pages grows subdirectories.
function astroRoutes(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // src/pages/public/ holds bundled assets, not routes.
      if (prefix === '' && entry === 'public') continue;
      out.push(...astroRoutes(full, `${prefix}${entry}/`));
    } else if (entry.endsWith('.astro')) {
      const base = entry.slice(0, -'.astro'.length);
      out.push(base === 'index' ? prefix.replace(/\/$/, '') : `${prefix}${base}`);
    }
  }
  return out;
}

// The public/ paths that would win the collision for a given route. Astro
// emits <route>/index.html; a public file at either spelling shadows it.
function shadowPathsFor(route) {
  return route === ''
    ? ['index.html']
    : [`${route}/index.html`, `${route}.html`];
}

console.log('ACR-991 homepage ownership proof');

// ---------------------------------------------------------------- source
console.log('\n-- src/pages -> public/ collisions');

const routes = astroRoutes(PAGES_DIR);
// A gate that enumerates nothing proves nothing.
ok('discovery finds .astro routes', routes.length > 0, `found ${routes.length}`);
ok('the site root is one of them', routes.includes(''), JSON.stringify(routes));
console.log(`     routes: ${JSON.stringify(routes.map((r) => `/${r}`))}`);

for (const route of routes) {
  for (const rel of shadowPathsFor(route)) {
    const full = join(PUBLIC_DIR, rel);
    ok(
      `/${route} is not shadowed by public/${rel}`,
      !existsSync(full),
      existsSync(full)
        ? `public/${rel} exists (${statSync(full).size} b) and Astro will serve it INSTEAD of src/pages/${route || 'index'}.astro`
        : '',
    );
  }
}

// The homepage this whole file exists to protect must actually be here. If
// index.astro is ever deleted, the collision check above goes vacuously green
// (no route, no collision) and the site loses the page with the suite still
// passing.
const indexAstro = join(PAGES_DIR, 'index.astro');
ok('src/pages/index.astro exists', existsSync(indexAstro));
if (existsSync(indexAstro)) {
  const size = statSync(indexAstro).size;
  // Not a snapshot of the design -- just proof this is the real hand-built
  // page and not a stub that happens to hold the filename.
  ok('src/pages/index.astro is the full hand-built page', size > 20000, `${size} b`);
}

// ------------------------------------------------------------------ dist
// The source check above can pass while the build still ships the wrong
// bytes, so the built artifact is checked on its own terms: the root page
// must carry Astro's fingerprint (hashed /_astro/ asset URLs, which only the
// bundler emits) and must not be a copy of anything under public/.
function checkDist(distRoot) {
  console.log(`\n-- dist (${distRoot})`);
  const distIndex = join(distRoot, 'index.html');
  ok('dist/index.html exists', existsSync(distIndex));
  if (!existsSync(distIndex)) return;

  const html = readFileSync(distIndex, 'utf8');
  const astroRefs = (html.match(/\/_astro\//g) || []).length;
  ok('dist/index.html is Astro-generated (/_astro/ asset refs)', astroRefs > 0, `${astroRefs} refs`);

  // Non-vacuity: /_astro/ has to be a signal that can distinguish. Another
  // known-Astro route must show it too, or the assertion above is measuring
  // nothing.
  const control = join(distRoot, 'welcome/index.html');
  if (existsSync(control)) {
    const controlRefs = (readFileSync(control, 'utf8').match(/\/_astro\//g) || []).length;
    ok('control: dist/welcome/index.html also carries /_astro/', controlRefs > 0, `${controlRefs} refs`);
  }

  // And it must not be a byte-copy of any page shipped under public/. This is
  // the direct statement of the defect: the served root was md5-identical to
  // public/index.html.
  const publicPages = [];
  (function rec(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) rec(full);
      else if (entry.endsWith('.html')) publicPages.push(full);
    }
  })(PUBLIC_DIR);
  const twin = publicPages.find((f) => readFileSync(f, 'utf8') === html);
  ok(
    'dist/index.html is not a copy of a public/ page',
    twin === undefined,
    twin ? `identical to public/${relative(PUBLIC_DIR, twin)}` : '',
  );
}

const distRoot = join(REPO_ROOT, 'dist');
const requireDist = process.argv.includes('--dist');
if (existsSync(distRoot)) {
  checkDist(distRoot);
} else if (requireDist) {
  ok('dist/ present (--dist given)', false, 'run `npx astro build` first');
} else {
  console.log('\n-- dist/ absent, skipped (run `npx astro build`, then re-run with --dist)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
