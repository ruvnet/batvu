// SPDX-License-Identifier: MIT
//
// Build the GitHub Pages site from the explainer source.
//
// `site/explainer.html` is written in the shape a Claude Artifact wants — a
// `<title>`, its font links, a `<style>`, then page content, with no
// `<!DOCTYPE>`, `<html>`, `<head>` or `<body>` of its own, because the Artifact
// host supplies those at publish time. Pages does not, so this wraps the same
// bytes in a real document.
//
// The point of wrapping rather than keeping a second copy is drift. Two
// near-identical HTML files in one repository diverge the first time somebody
// edits one of them, and the divergence is invisible until a reader notices the
// hosted page and the published artifact disagree. One source, two renderings.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'site/explainer.html');
const DIST = join(root, 'site/dist');

// Where the social card lives once deployed. Open Graph requires an absolute
// URL — a relative one is silently ignored by every crawler that reads it.
const BASE = process.env.SITE_BASE_URL ?? 'https://ruvnet.github.io/batvu';

const source = readFileSync(SRC, 'utf8');

// The split rule, stated once: everything through `</style>` is head material,
// everything after it is body. That holds for the artifact format and fails
// loudly rather than silently producing a broken document if it ever stops
// holding.
const marker = '</style>';
const cut = source.indexOf(marker);
if (cut === -1) {
  throw new Error(`${SRC}: no </style> found — cannot tell head from body. ` +
    'If the explainer no longer has a single leading style block, this script needs updating.');
}
const head = source.slice(0, cut + marker.length);
const body = source.slice(cut + marker.length);

const title = (head.match(/<title>([^<]*)<\/title>/) ?? [, 'BatVu'])[1];
const description =
  'How a phone maps a dark room with a sound you cannot hear — and the four ' +
  'defects that hid behind green tests.';

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${description}">
<meta name="color-scheme" content="dark">
<link rel="canonical" href="${BASE}/">
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${BASE}/">
<meta property="og:image" content="${BASE}/explainer-hero.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>%F0%9F%A6%87</text></svg>">
${head}
</head>
<body>
${body}
</body>
</html>
`;

mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'index.html'), page);

// The social card ships with the page so the og:image resolves.
const card = join(root, 'docs/img/explainer-hero.jpg');
if (existsSync(card)) copyFileSync(card, join(DIST, 'explainer-hero.jpg'));

console.log(`  built site/dist/index.html (${Math.round(page.length / 1024)} KB) from site/explainer.html`);
