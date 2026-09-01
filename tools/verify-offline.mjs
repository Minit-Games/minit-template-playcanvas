// Does the built game actually touch the network?
//
//   node tools/verify-offline.mjs      (runs as part of `npm run package`)
//
// The platform forbids fetch/XMLHttpRequest and any external request, and its
// validation sweep looks for those names in the code. That works for a
// hand-written game and not for an engine: PlayCanvas bundles its own asset
// loader, so both names are present in the bundle whether or not a single
// resource handler is registered. Grepping would fail every engine-based game
// while proving nothing about what it does.
//
// So this measures the behaviour instead. It loads the built bundle, plays it,
// and records every request the page actually makes. Anything not served from
// the bundle's own origin is a failure.
import { launch } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9869;
const ORIGIN = `http://localhost:${PORT}`;

const server = spawn('node', [join(ROOT, 'tools/serve.mjs'), join(ROOT, 'dist'), String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));

const b = await launch({ width: 420, height: 630, dpr: 1, autoplay: false });
const requests = [];
try {
	await b.page.send('Network.enable');
	b.page.on('Network.requestWillBeSent', (p) => requests.push(p.request.url));

	await b.addInitScript(`window.minit = { environment: 'app', dropConfig: {},
		loadingDone() {}, reportResult() {} };`);
	await b.goto(`${ORIGIN}/`);
	await new Promise((r) => setTimeout(r, 3000));
	// Play a little: asset loading is often lazy, so an idle page proves less.
	for (let i = 0; i < 5; i++) {
		await b.tap([{ x: 210, y: 430 }], 50);
		await new Promise((r) => setTimeout(r, 500));
	}
	await new Promise((r) => setTimeout(r, 1500));
} finally {
	await b.close();
	server.kill();
}

// data: and blob: never leave the page.
const external = requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:'));
const unique = [...new Set(requests)].map((u) => u.replace(ORIGIN, ''));

console.log(`\noffline verification (${requests.length} requests observed)`);
for (const u of unique.slice(0, 12)) { console.log(`  ${u}`); }
if (external.length) {
	console.error(`\n  ERROR: the game requested ${external.length} external resource(s):`);
	for (const u of [...new Set(external)].slice(0, 8)) { console.error(`    ${u}`); }
	console.error('  The WebView is sandboxed with no network -- these fail silently in the app.\n');
	process.exit(1);
}
console.log('  every request came from the bundle itself\n');
