// Does this build actually make a sound inside the app?
//
//   node tools/verify-audio.mjs        (runs as part of `npm run package`)
//
// The engine flag for "is the music playing" is not evidence -- a game can be
// mixing perfectly into a gain node the app is holding at zero, which is the
// exact production failure this template exists to prevent. So this measures
// the audio graph: an AnalyserNode spliced after the app's mute gain, peak RMS
// over a few real taps.
//
// Two cases, and BOTH have to hold:
//
//   host silent  -- the app never states a volume. The game must recover and
//                   be audible, because a 0 nobody chose is not a mute.
//   host mutes   -- the app explicitly says 0. The game must stay silent, or
//                   the repair is overriding a player who turned sound off.
//
// The browser starts with autoplay disabled, so the AudioContext is created
// suspended exactly as it is in a WKWebView. Without that, the whole suspended
// path goes untested and a silent build passes.
import { launch } from './cdp.mjs';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9871;

// Which directory holds the built game. Every bundler template writes dist/,
// but the engines do not: Godot exports to dist/web, Unity to Build/MinitWebGL,
// and Defold to a folder named after the project title -- spaces and all. Pass
// it as the first argument.
const BUILT = process.argv[2] || 'dist';

const PROBE = `
window.__peak = 0;
window.__installAnalyser = function () {
	var c = (window.__dropAudioContexts || [])[0];
	if (!c || window.__an) { return false; }
	var a = c.createAnalyser();
	a.fftSize = 2048;
	// Splice in after the app's mute gain, so what is measured is what would
	// reach the speaker -- not what the game handed to the mixer.
	if (c._muteGain) { try { c._muteGain.disconnect(); } catch (e) {} c._muteGain.connect(a); }
	a.connect(c._trueDestination || c.destination);
	window.__an = a;
	var buf = new Float32Array(a.fftSize);
	setInterval(function () {
		a.getFloatTimeDomainData(buf);
		var s = 0;
		for (var i = 0; i < buf.length; i++) { s += buf[i] * buf[i]; }
		var r = Math.sqrt(s / buf.length);
		if (r > window.__peak) { window.__peak = r; }
	}, 30);
	return true;
};
`;

async function stage(initialVolume) {
	const dir = await mkdtemp(join(tmpdir(), 'minit-audio-'));
	await cp(join(ROOT, BUILT), dir, { recursive: true });
	const host = await readFile(join(ROOT, 'tools/fake-host-audio.js'), 'utf8');
	const p = join(dir, 'index.html');
	const html = await readFile(p, 'utf8');
	// The double has to run before the page's own scripts, exactly as the app's
	// injection does at document start.
	await writeFile(p, `<script>window.__fakeHostInitialVolume=${initialVolume};\n${host}\n${PROBE}</script>\n${html}`);
	return dir;
}

async function measure({ mutes }) {
	const dir = await stage(0);
	const server = spawn('node', [join(ROOT, 'tools/serve.mjs'), dir, String(PORT)], { stdio: 'ignore' });
	await new Promise((r) => setTimeout(r, 500));
	const b = await launch({ width: 390, height: 844, dpr: 1, autoplay: false });
	try {
		await b.goto(`http://localhost:${PORT}/`);
		await new Promise((r) => setTimeout(r, 2500));
		if (mutes) {
			// The app deliberately mutes this drop. Posted with the opaque
			// origin iOS actually uses, so the repair's retry path is exercised.
			await b.eval(`window.postMessage({type:'minit.fadeDropAudioVolume',value:0,duration:0.3},'null')`);
			await new Promise((r) => setTimeout(r, 500));
		}
		await b.eval('window.__installAnalyser(); window.__peak = 0;');
		const { width, height } = { width: 390, height: 844 };
		// Sweep down the middle instead of aiming at one guessed point. Where
		// the ball rests differs per engine -- and Defold's y axis runs the
		// other way -- so a single coordinate that happens to hit one template
		// silently misses in another, and a miss here reads as "no audio"
		// rather than "bad tap".
		const column = [0.40, 0.48, 0.54, 0.58, 0.62, 0.70].map((f) => Math.round(height * f));
		for (let round = 0; round < 2; round++) {
			for (const y of column) {
				await b.tap([{ x: width / 2, y }], 60);
				await new Promise((r) => setTimeout(r, 260));
			}
		}
		return await b.eval('window.__peak');
	} finally {
		await b.close();
		server.kill();
	}
}

const AUDIBLE = 0.02;      // well above measurement noise, well below a real signal

const silentHost = await measure({ mutes: false });
const mutingHost = await measure({ mutes: true });

console.log(`\naudio verification (peak output RMS, measured after the app's mute gain)`);
console.log(`  host never states a volume : ${silentHost.toFixed(5)}  (must be audible)`);
console.log(`  host explicitly mutes      : ${mutingHost.toFixed(5)}  (must be silent)`);

const problems = [];
if (silentHost <= AUDIBLE) {
	problems.push('the game is SILENT when the app never states a volume -- the repair in index.html is not working.');
}
if (mutingHost > AUDIBLE) {
	problems.push('the game plays THROUGH an explicit mute -- the repair is overriding the app.');
}
if (problems.length) {
	for (const p of problems) { console.error(`  ERROR: ${p}`); }
	console.error('');
	process.exit(1);
}
console.log('  both hold\n');
