// Build, verify, and produce the ZIP to upload at https://console.minit.games
//
//   npm run package
//
// Node rather than bash: this is the only packaging entry point, and it has to
// work on Windows, where bash, zip, unzip and du do not exist. Every step below
// is either Node or a Node script, so there is one spelling of the staged file
// list and one entry point on every platform.
//
// The ZIP's root is the CONTENTS of dist/ -- index.html at the top, no dist/
// folder, no src/, no package.json, no vite config. The console rejects an
// upload that still looks like a source tree.
import { spawnSync } from 'node:child_process';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { zipDir } from './zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

// The archive is named from package.json, so a fork that renames the project
// gets a correctly named upload without having to remember to edit this file.
const { name: NAME } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const OUT = join('dist', `${NAME}.zip`);

/** Run a Node script in-process-group and abort packaging if it fails. */
function run(script, args = []) {
	// process.execPath, not "node"/"npx": no shell, no .cmd shim, and the same
	// Node that is running this file.
	const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
	if (r.status !== 0) { process.exit(r.status ?? 1); }
}

console.log('==> building');
// vite's own JS entry, rather than `npx vite` -- npx is npx.cmd on Windows and
// needs a shell to resolve, which is what this file exists to avoid.
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(VITE)) {
	console.error('vite is not installed -- run `npm install` first.');
	process.exit(1);
}
run(VITE, ['build']);

console.log('==> pre-flight');
run(join('tools', 'check-meta.mjs'));

console.log('==> offline');
// The engine bundles its own asset loader containing fetch and XMLHttpRequest,
// so a grep cannot answer this. Measure what the game actually requests.
run(join('tools', 'verify-offline.mjs'));

console.log('==> audio');
// A build that is silent inside the app looks completely healthy from every
// other angle, so this measures the audio graph rather than trusting a flag.
// It is in the packaging path deliberately: a silent build cannot be shipped.
run(join('tools', 'verify-audio.mjs'));

console.log('==> packaging');
await rm(OUT, { force: true });
// Build the archive outside dist/ and move it in, so it can never contain a
// copy of itself however the file walk is ordered.
const staging = join(ROOT, `.${NAME}.zip.tmp`);
const { bytes, names } = await zipDir(join(ROOT, 'dist'), staging);
await rename(staging, join(ROOT, OUT));

const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
console.log(`\nwrote ${OUT} (${kb(bytes)})`);
for (const n of names) {
	console.log(`  ${String((await stat(join(ROOT, 'dist', n))).size).padStart(9)}  ${n}`);
}
console.log(`\nUpload ${OUT} at https://console.minit.games`);
