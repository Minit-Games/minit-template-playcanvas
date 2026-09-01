// Prepares the background music loop and inlines it into the bundle.
//
//   node tools/gen-music.mjs
//
// Source: "Title Screen" from "5 Chiptunes (Action)" by Juhani Junkala
// (SubspaceAudio), CC0 / public domain -- the author's own INFO.txt says "You
// can do anything you want with these tunes." It is the shortest track in the
// pack, which keeps a template's download small.
//
// Why the music is inlined as text rather than shipped as a file:
//
// The platform rules for AI-built games forbid fetch() and XMLHttpRequest, and
// the validation sweep greps for them -- so the usual "fetch the .ogg, hand the
// ArrayBuffer to decodeAudioData" route is out. An <audio> element plus
// createMediaElementSource would avoid fetch, but that path has a long history
// of returning silence on iOS, and this template's whole point is audio that
// survives the app. So the bytes travel inside the JS bundle and are decoded to
// an AudioBuffer in code -- the exact path measured working in the Defold,
// Godot and Unity templates.
//
// Base64 of 16-bit PCM would be 470 KB. G.711 mu-law halves the PCM first: it
// is a logarithmic 8-bit encoding, so quantisation noise scales with signal
// level instead of sitting at a fixed floor. On a chiptune -- square waves,
// already quantised, no quiet passages to expose a noise floor -- the cost is
// inaudible, and the decoder is nine lines (see src/audio.js).
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache');
const PACK_URL = 'https://opengameart.org/sites/default/files/5%20Action%20Chiptunes%20By%20Juhani%20Junkala.zip';
const PACK_ZIP = join(CACHE, 'junkala-action-chiptunes.zip');
const TRACK = 'Juhani Junkala [Retro Game Music Pack] Title Screen.wav';

const OUT_RATE = 16000;
const PEAK = 0.72;   // headroom for the effects mixed over the top

function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file');
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}`);
  let off = 12;                                   // walk chunks; the header is not always 44 bytes
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const data = buf.subarray(off + 8, off + 8 + Math.min(len, buf.length - off - 8));
      const frames = Math.floor(data.length / 2 / channels);
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += data.readInt16LE((i * channels + c) * 2);
        mono[i] = s / channels / 32768;
      }
      return { rate, channels, samples: mono };
    }
    off += 8 + len + (len & 1);
  }
  throw new Error('no data chunk');
}

/** Two one-pole passes: gentle, but enough to keep decimation from aliasing. */
function lowpass(x, rate, cut) {
  const k = 1 - Math.exp(-2 * Math.PI * cut / rate);
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += k * (x[i] - y); out[i] = y; }
  y = 0;
  for (let i = out.length - 1; i >= 0; i--) { y += k * (out[i] - y); out[i] = y; }
  return out;
}

/** Linear resample, wrapping the interpolation so a seamless loop stays seamless. */
function resample(x, from, to) {
  const n = Math.round(x.length * to / from);
  const out = new Float32Array(n);
  const step = x.length / n;
  for (let i = 0; i < n; i++) {
    const p = i * step, i0 = Math.floor(p), frac = p - i0;
    out[i] = x[i0] * (1 - frac) + x[(i0 + 1) % x.length] * frac;
  }
  return out;
}

/** G.711 mu-law. Mirrored by muLawDecode() in src/audio.js. */
function muLawEncode(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawDecode(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  const s = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return (sign ? -s : s) / 32768;
}

await mkdir(CACHE, { recursive: true });
if (!(await stat(PACK_ZIP).catch(() => null))) {
  console.log('  fetching the CC0 pack (~47 MB, cached in .cache/ for next time)');
  execFileSync('curl', ['-sfL', '-A', 'Mozilla/5.0', '-o', PACK_ZIP, PACK_URL], { stdio: 'inherit' });
}

const escaped = TRACK.replace(/([[\]*?\\])/g, '\\$1');   // unzip globs its arguments
const src = readWav(execFileSync('unzip', ['-p', PACK_ZIP, escaped], { maxBuffer: 64 * 1024 * 1024 }));
console.log(`  source: ${src.channels}ch ${src.rate} Hz, ${(src.samples.length / src.rate).toFixed(1)}s`);

const down = resample(lowpass(src.samples, src.rate, OUT_RATE * 0.45), src.rate, OUT_RATE);
let peak = 0;
for (const v of down) peak = Math.max(peak, Math.abs(v));
const gain = peak > 0 ? PEAK / peak : 1;
for (let i = 0; i < down.length; i++) down[i] *= gain;

// Is the loop seamless? Compare the wrap-around step against how much
// neighbouring samples normally differ. A seam inside that range is inaudible.
const steps = [];
for (let i = 1; i < down.length; i++) steps.push(Math.abs(down[i] - down[i - 1]));
steps.sort((a, b) => a - b);
const p95 = steps[Math.floor(steps.length * 0.95)];
const seam = Math.abs(down[down.length - 1] - down[0]);
console.log(`  loop seam ${seam.toFixed(4)} vs p95 adjacent step ${p95.toFixed(4)} -> ` +
            (seam <= p95 ? 'continuous' : 'AUDIBLE SEAM, consider a crossfade'));

const encoded = Buffer.alloc(down.length);
for (let i = 0; i < down.length; i++) encoded[i] = muLawEncode(down[i]);

// What the encoding actually cost, rather than trusting that it is fine.
let err = 0;
for (let i = 0; i < down.length; i++) { const d = muLawDecode(encoded[i]) - down[i]; err += d * d; }
const rmsErr = Math.sqrt(err / down.length);
let sig = 0;
for (const v of down) sig += v * v;
const snr = 20 * Math.log10(Math.sqrt(sig / down.length) / rmsErr);
console.log(`  mu-law round trip: ${snr.toFixed(1)} dB SNR (chiptune content; >30 dB is transparent here)`);

const b64 = encoded.toString('base64');
await writeFile(join(ROOT, 'src/assets/music.js'),
  `// GENERATED by tools/gen-music.mjs -- do not edit by hand.\n` +
  `// "Title Screen" from 5 Chiptunes (Action) by Juhani Junkala (SubspaceAudio), CC0.\n` +
  `// Mono ${OUT_RATE} Hz, G.711 mu-law, decoded by muLawDecode() in ../audio.js.\n` +
  `export const MUSIC_RATE = ${OUT_RATE};\n` +
  `export const MUSIC_MULAW_BASE64 =\n  '${b64}';\n`);

console.log(`  wrote src/assets/music.js - mono ${OUT_RATE} Hz, ${(down.length / OUT_RATE).toFixed(1)}s, ` +
            `${(b64.length / 1024).toFixed(0)} KB of base64 (${(encoded.length / 1024).toFixed(0)} KB decoded)`);
