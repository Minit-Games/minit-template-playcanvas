/* ==========================================================================
   Audio.

   Everything the game makes noise with lives here, on one AudioContext:

     * the music loop, decoded from the mu-law bytes the build inlined; and
     * the effects, synthesised on the spot -- a tap, a bounce, a finish
       chord. Three short blips are a few lines of oscillator each, which is
       smaller and sharper than shipping three more files.

   Two buses hang off the master gain so the `sound` and `music` config values
   can be honoured independently, and so a run with music off still has its
   effects.

   The reason this file is longer than "new AudioContext(), play a sound" is
   the Minit app, which is dealt with in index.html rather than here -- see the
   comment there. What belongs here is the half the game owns: never start
   audio before a gesture has unlocked the context, and hand the context to the
   SDK so it suspends and resumes with the page.
   ========================================================================== */
import { registerAudioContext } from '@minit-games/sdk';
import { MUSIC_RATE, MUSIC_MULAW_BASE64 } from './assets/music.js';

/** G.711 mu-law. Mirrors muLawEncode() in tools/gen-music.mjs. */
function muLawDecode(u) {
	u = ~u & 0xff;
	const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
	const s = (((mantissa << 3) + 0x84) << exponent) - 0x84;
	return (sign ? -s : s) / 32768;
}

export function createAudio({ sound = true, music = true } = {}) {
	const Ctx = window.AudioContext || window.webkitAudioContext;
	if (!Ctx) { return nullAudio(); }

	const ctx = new Ctx();
	// The SDK suspends this when the page hides and resumes it when the page
	// returns -- but only if it was the one that suspended it, so a context the
	// player has muted stays muted.
	registerAudioContext(ctx);

	const master = ctx.createGain();
	master.gain.value = 1;
	master.connect(ctx.destination);

	const sfxBus = ctx.createGain();
	sfxBus.gain.value = sound ? 0.9 : 0;
	sfxBus.connect(master);

	const musicBus = ctx.createGain();
	musicBus.gain.value = 0;                 // faded in once the loop starts
	musicBus.connect(master);

	// Decoding 176 KB of mu-law is fast, but it is still work on the main
	// thread during startup, so it happens once here and the buffer is reused.
	const bytes = atob(MUSIC_MULAW_BASE64);
	const buffer = ctx.createBuffer(1, bytes.length, MUSIC_RATE);
	const channel = buffer.getChannelData(0);
	for (let i = 0; i < bytes.length; i++) { channel[i] = muLawDecode(bytes.charCodeAt(i)); }

	let musicSource = null;
	let wantMusic = music;
	let unlocked = false;

	/* ---- unlocking -----------------------------------------------------
	   A context created outside a gesture starts suspended, and anything
	   played into it is discarded rather than queued. So the game must not
	   start the music until a real gesture has run resume() to completion --
	   starting it early does not just delay the sound, it loses the beginning
	   of the loop. Every entry point below routes through unlock(). */
	async function unlock() {
		if (ctx.state !== 'running') {
			try { await ctx.resume(); } catch { /* refused outside a gesture; retried on the next one */ }
		}
		if (ctx.state === 'running' && !unlocked) {
			unlocked = true;
			if (wantMusic) { startMusic(); }
		}
		return unlocked;
	}

	function startMusic() {
		if (musicSource || !wantMusic || ctx.state !== 'running') { return; }
		musicSource = ctx.createBufferSource();
		musicSource.buffer = buffer;
		musicSource.loop = true;
		musicSource.connect(musicBus);
		musicSource.start();
		musicBus.gain.cancelScheduledValues(ctx.currentTime);
		musicBus.gain.setValueAtTime(0, ctx.currentTime);
		musicBus.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.8);
	}

	function stopMusic() {
		if (!musicSource) { return; }
		const source = musicSource;
		musicSource = null;
		musicBus.gain.cancelScheduledValues(ctx.currentTime);
		musicBus.gain.setValueAtTime(musicBus.gain.value, ctx.currentTime);
		musicBus.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4);
		try { source.stop(ctx.currentTime + 0.5); } catch { /* already stopped */ }
	}

	/* ---- effects -------------------------------------------------------
	   Each is one short envelope over one or two oscillators. The envelopes
	   all decay to a small positive value rather than 0 because
	   exponentialRampToValueAtTime cannot reach zero, and an exponential
	   decay is what a struck object actually sounds like. */
	function blip({ type = 'sine', from, to, duration, peak, delay = 0 }) {
		if (ctx.state !== 'running') { return; }
		const t = ctx.currentTime + delay;
		const osc = ctx.createOscillator();
		const env = ctx.createGain();
		osc.type = type;
		osc.frequency.setValueAtTime(from, t);
		if (to !== from) { osc.frequency.exponentialRampToValueAtTime(to, t + duration); }
		env.gain.setValueAtTime(0.0001, t);
		env.gain.exponentialRampToValueAtTime(peak, t + 0.008);
		env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
		osc.connect(env);
		env.connect(sfxBus);
		osc.start(t);
		osc.stop(t + duration + 0.02);
	}

	return {
		context: ctx,
		unlock,

		/** The player hit the ball: a bright upward chirp. */
		tap() { blip({ type: 'triangle', from: 520, to: 980, duration: 0.14, peak: 0.5 }); },

		/** The ball hit the grass: a low, short thud. */
		bounce() { blip({ type: 'sine', from: 190, to: 70, duration: 0.20, peak: 0.45 }); },

		/** The run ended: a small major arpeggio, so the end reads as an event. */
		finish() {
			[0, 0.09, 0.18].forEach((delay, i) => {
				blip({ type: 'square', from: [523, 659, 784][i], to: [523, 659, 784][i],
				       duration: 0.42 - i * 0.05, peak: 0.28, delay });
			});
		},

		setSound(on) { sfxBus.gain.value = on ? 0.9 : 0; },

		setMusic(on) {
			wantMusic = on;
			if (on) { if (unlocked) { startMusic(); } } else { stopMusic(); }
		},
	};
}

/** Used where there is no Web Audio at all, so callers never branch. */
function nullAudio() {
	const noop = () => {};
	return { context: null, unlock: async () => false, tap: noop, bounce: noop,
	         finish: noop, setSound: noop, setMusic: noop };
}
