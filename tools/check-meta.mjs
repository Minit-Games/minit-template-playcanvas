// Pre-flight for the built bundle. Runs as part of `npm run build`.
//
// Two jobs: validate meta.json against the rules the Creator Console applies
// on upload, and run the platform's own validation sweep over dist/ -- the
// forbidden APIs, the ZIP shape, and the things that only fail once the game
// is already inside the app.
//
// Exits non-zero on an error so a broken bundle cannot be packaged. Notes are
// advisory and do not fail the build.
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const errors = [];
const notes = [];
const fail = (m) => errors.push(m);
const note = (m) => notes.push(m);

/* ---- dist shape ------------------------------------------------------- */
async function walk(dir, out = []) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) { await walk(p, out); } else { out.push(p); }
	}
	return out;
}

if (!(await stat(DIST).catch(() => null))) {
	console.error('dist/ does not exist -- run `npm run build` first.');
	process.exit(1);
}

const files = await walk(DIST);
const rel = files.map((f) => relative(DIST, f));

if (!rel.includes('index.html')) { fail('index.html must be at the root of dist/, and therefore of the ZIP.'); }
if (!rel.includes('meta.json')) { fail('meta.json must be at the root of dist/ -- put it in public/.'); }

// The console rejects an upload that still looks like a source tree.
for (const bad of ['package.json', 'vite.config.js', 'vite.config.ts']) {
	if (rel.includes(bad)) { fail(`dist/ contains ${bad}; the console rejects uploads that look unbuilt.`); }
}
if (rel.some((f) => f.startsWith('src/'))) { fail('dist/ contains a src/ folder; the console rejects that.'); }

/* ---- forbidden APIs and external references ---------------------------
   The game WebView is sandboxed with no network, and the platform's own sweep
   greps for these. A relative asset URL is fine; an absolute one is not. */
const html = await readFile(join(DIST, 'index.html'), 'utf8');
const js = (await Promise.all(
	files.filter((f) => f.endsWith('.js')).map((f) => readFile(f, 'utf8'))
)).join('\n');
const bundle = html + '\n' + js;

// Scanned against FIRST-PARTY source, not the built bundle. The rule is that
// the game must not reach the network or browser storage -- but a bundled
// engine carries its own asset loader, and PlayCanvas's contains both fetch
// and XMLHttpRequest whether or not a single resource handler is registered.
// Failing on that would make every engine-based game unshippable while proving
// nothing: what matters is whether a request is actually made, which
// tools/verify-offline.mjs measures at runtime instead.
// Comments are stripped first. Without that, a source file DOCUMENTING that
// fetch and XMLHttpRequest are forbidden trips the very check it is explaining
// -- which is exactly what happened here.
const stripComments = (src) => src
	.replace(/\/\*[\s\S]*?\*\//g, '')       // block comments
	.replace(/^[ \t]*\/\/.*$/gm, '');        // whole-line // comments

const firstParty = stripComments((await Promise.all(
	(await walk(join(ROOT, 'src'))).filter((f) => f.endsWith('.js')).map((f) => readFile(f, 'utf8'))
)).join('\n'));

for (const [name, re] of [
	['localStorage', /\blocalStorage\b/],
	['sessionStorage', /\bsessionStorage\b/],
	['XMLHttpRequest', /\bXMLHttpRequest\b/],
	['fetch(', /(^|[^.\w])fetch\s*\(/],
]) {
	if (re.test(firstParty)) { fail(`src/ references ${name}, which is forbidden -- the game runs sandboxed.`); }
	else if (re.test(bundle)) { note(`${name} appears in bundled dependency code (not in src/); tools/verify-offline.mjs checks no request is actually made.`); }
}

// Also first-party only, and for the same reason: an engine bundle is full of
// URLs it never requests -- Pixi prints its own homepage in a console banner,
// libraries carry licence headers and doc links in error messages. What
// matters is whether a request is made, which verify-offline.mjs measures.
const external = [...firstParty.matchAll(/https?:\/\/[^\s"'`)]+/g)]
	.map((m) => m[0])
	.filter((u) => !/w3\.org|creativecommons|opengameart|github\.com|minit\.(studio|games)|fonts\.google/.test(u));
if (external.length) {
	fail(`src/ contains external URLs, which cannot load in the app: ${[...new Set(external)].slice(0, 4).join(', ')}`);
}
if (/<link[^>]+fonts\.googleapis/.test(html)) {
	fail('index.html links Google Fonts; bundle woff2 files instead -- external requests fail silently in the app.');
}
if (/\ssrc=["']\//.test(html) || /\shref=["']\/[^/]/.test(html)) {
	fail('index.html uses absolute asset paths; set base: "./" in vite.config.js.');
}
if (/crossorigin/.test(html)) {
	fail('index.html has a crossorigin attribute; under minitlocal:// its CORS check cannot pass.');
}

/* ---- lifecycle -------------------------------------------------------- */
if (!/loadingDone/.test(js)) { fail('no loadingDone() in the bundle -- the app would sit on its loading screen.'); }
if (!/reportResult/.test(js)) { fail('no reportResult() in the bundle -- the run could never be scored.'); }

/* ---- size ------------------------------------------------------------- */
const bytes = (await Promise.all(files.map(async (f) => (await stat(f)).size))).reduce((a, b) => a + b, 0);
const mb = bytes / 1048576;
if (mb > 5) { fail(`bundle is ${mb.toFixed(2)} MB; 5 MB is the practical ceiling.`); }
else if (mb > 1) { note(`bundle is ${mb.toFixed(2)} MB; the docs ask for well under 1 MB for instant loading.`); }

/* ---- meta.json -------------------------------------------------------- */
let meta;
try {
	meta = JSON.parse(await readFile(join(DIST, 'meta.json'), 'utf8'));
} catch (e) {
	fail(`meta.json is not valid JSON: ${e.message}`);
	meta = null;
}

if (meta) {
	for (const field of ['title', 'controls', 'logic', 'description']) {
		if (!meta[field] || !String(meta[field]).trim()) { note(`meta.json has no ${field}; the console will skip it.`); }
	}
	if (meta.title && !/\p{Extended_Pictographic}/u.test(meta.title)) {
		note('meta.json title has no emoji; the documented format is "<Name> <two matching emojis>".');
	}
	if (meta.resultSorting &&
		!['highestScore', 'lowestScore', 'fastestTime', 'slowestTime'].includes(meta.resultSorting)) {
		fail(`meta.json resultSorting "${meta.resultSorting}" is not a recognised value.`);
	}
	if (meta.sourceUrl && !/^https?:\/\//.test(meta.sourceUrl)) {
		fail('meta.json sourceUrl must start with http:// or https://.');
	}

	// A malformed `config` block is dropped WHOLE and silently, taking every
	// knob with it -- so the rules are checked here rather than discovered
	// when a mod does nothing.
	if (meta.config !== undefined) {
		if (!Array.isArray(meta.config)) { fail('meta.json config must be an array.'); }
		else {
			if (meta.config.length > 25) { fail(`meta.json config has ${meta.config.length} entries; the maximum is 25.`); }
			const seen = new Set();
			const types = ['string', 'number', 'boolean', 'color'];
			for (const [i, entry] of meta.config.entries()) {
				const at = `meta.json config[${i}]`;
				const key = typeof entry.key === 'string' ? entry.key.trim() : '';
				if (!key) { fail(`${at} has no key.`); }
				else if (seen.has(key)) { fail(`${at} duplicates the key "${key}".`); }
				else { seen.add(key); }

				if (!types.includes(entry.valueType)) { fail(`${at} valueType must be one of ${types.join(', ')}.`); }
				const value = entry.value !== undefined ? entry.value : entry.defaultValue;
				if (value === undefined) { fail(`${at} needs a value (or defaultValue).`); }

				if (entry.valueType === 'boolean' && value !== undefined &&
					!['true', 'false'].includes(String(value))) {
					fail(`${at} boolean value must be exactly "true" or "false".`);
				}
				if (entry.valueType === 'number' && value !== undefined && !Number.isFinite(Number(value))) {
					fail(`${at} number value must parse to a finite number.`);
				}
				if (entry.valueType === 'color' && value !== undefined &&
					!/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(value))) {
					fail(`${at} color value must be #RRGGBB or #RRGGBBAA.`);
				}

				const hasBounds = ['min', 'max', 'minLength', 'maxLength'].some((k) => entry[k] !== undefined);
				if (entry.range !== undefined && hasBounds) {
					fail(`${at} cannot combine range with min/max bounds.`);
				}
				if (entry.range !== undefined) {
					if (!Array.isArray(entry.range) || !entry.range.length) { fail(`${at} range must be a non-empty array.`); }
					else if (value !== undefined && !entry.range.map(String).includes(String(value))) {
						fail(`${at} value "${value}" is not a member of its own range.`);
					}
				}
				for (const k of ['min', 'max']) {
					if (entry[k] !== undefined && entry.valueType !== 'number') { fail(`${at} ${k} applies only to number.`); }
					if (entry[k] !== undefined && typeof entry[k] !== 'number') { fail(`${at} ${k} must be a JSON number, not a string.`); }
				}
				for (const k of ['minLength', 'maxLength']) {
					if (entry[k] !== undefined && entry.valueType !== 'string') { fail(`${at} ${k} applies only to string.`); }
				}
				if (typeof entry.min === 'number' && typeof entry.max === 'number' && entry.min > entry.max) {
					fail(`${at} has min greater than max.`);
				}
				if (typeof entry.minLength === 'number' && typeof entry.maxLength === 'number' &&
					entry.minLength > entry.maxLength) {
					fail(`${at} has minLength greater than maxLength.`);
				}
				if (typeof entry.description === 'string' && entry.description.length > 100) {
					note(`${at} description is over 100 characters and will be dropped.`);
				}
			}

			// The declared knobs and the ones the game actually reads should
			// agree -- a key in one and not the other is always a mistake.
			// Match the key as a string literal rather than the getConfigValue
			// call: the build is minified, so the function name is gone but the
			// key it is called with survives verbatim.
			for (const key of seen) {
				if (!new RegExp(`["'\`]${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`).test(js)) {
					note(`meta.json declares "${key}" but the bundle never reads it.`);
				}
			}
		}
	}

	const notices = rel.includes('THIRD-PARTY-NOTICES.txt');
	const noticeRequired = meta.license && !['CC0-1.0', 'Unlicense', 'proprietary'].includes(meta.license);
	if (noticeRequired && !notices) {
		note(`license ${meta.license} requires a THIRD-PARTY-NOTICES.txt at the ZIP root.`);
	}
	for (const banned of ['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-NC-ND-4.0', 'GPL-2.0', 'GPL-3.0',
		'GPL-2.0-only', 'GPL-3.0-only', 'GPL-2.0-or-later', 'GPL-3.0-or-later',
		'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later']) {
		if (meta.license === banned) { fail(`license ${banned} fails upload -- the platform will not host it.`); }
	}
}

/* ---- report ----------------------------------------------------------- */
console.log(`\npre-flight: ${rel.length} files, ${mb.toFixed(2)} MB`);
for (const n of notes) { console.log(`  note: ${n}`); }
for (const e of errors) { console.error(`  ERROR: ${e}`); }
if (errors.length) {
	console.error(`\n${errors.length} problem(s) would break the upload or the game.\n`);
	process.exit(1);
}
console.log('  all checks passed\n');
