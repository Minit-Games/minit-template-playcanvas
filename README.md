# minit-template-playcanvas

> **Learn page:** [PlayCanvas on Minit](https://minit.studio/docs/playcanvas) — the official guide this template implements.

A complete, working Minit game on the [PlayCanvas](https://playcanvas.com)
engine, built with Vite and the official
[`@minit-games/sdk`](https://www.npmjs.com/package/@minit-games/sdk). Same game
as the Defold, Godot, Unity and vanilla templates, in 3D.

**The game.** A ball sits on the grass. Tap it and it bounces, and every tap
scores. Hit it again in mid-air to build a rally; let it land and the rally
resets. A 30 second clock ends the run and posts the result -- the host owns
what happens either side of a run, so the game never asks the player to end it.

```bash
npm install
npm run dev        # local dev server
npm run package    # build, verify, and write dist/minit-template-playcanvas.zip
```

Upload `dist/minit-template-playcanvas.zip` at
[console.minit.games](https://console.minit.games).

## Tools and configuration

Everything in `tools/` needs **Node 22 or newer** and a Chromium-based browser.
There is nothing else to install — the scripts use only Node built-ins.

**The browser.** The audio gate drives a real browser over the DevTools
protocol, so it needs one present. It takes the first that exists on disk, which
on most machines means there is nothing to configure:

| OS | Tried, in order |
|---|---|
| macOS | Google Chrome, Microsoft Edge, Chromium |
| Windows | Google Chrome, Microsoft Edge *(Edge ships with Windows)* |
| Linux | `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge` |

Set `CHROME` to override it with any Chromium build. On macOS and Linux:

```bash
CHROME="/path/to/chrome" npm run package
```

and on Windows, from `cmd`:

```
set CHROME=C:\path\to\msedge.exe
npm run package
```

If none is found the run stops immediately and lists every path it tried.
Opera is deliberately *not* tried: it is Chromium, but several builds refuse
remote debugging and then fail exactly like a missing browser.

### On Windows, use `cmd` rather than PowerShell

PowerShell's execution policy blocks `npm.ps1`, so any `npm run …` fails with
*"running scripts is disabled on this system"* before this template runs at all.
That is a Windows security setting rather than anything here, and you do not
need to weaken it — use `cmd`, or call Node directly:

```
node tools/package.mjs
```
## Layout

```
index.html            page shell + two repairs (User-Agent, audio) — read the comments
src/main.js           SDK lifecycle, scoring, HUD — the part worth copying
src/scene.js          the 3D scene: camera, light, ground, ball, physics
src/audio.js          one AudioContext: the music loop and synthesised effects
src/assets/music.js   generated — the loop, as inlined mu-law bytes
public/meta.json      title, controls, logic, description, config knobs
public/THIRD-PARTY-NOTICES.txt
tools/                build, validation, and the offline + audio gates
```

`public/` is copied verbatim to the root of `dist/`, which puts `meta.json` and
the notices at the root of the ZIP where the console reads them.

## The three calls that matter

A Minit drop is one session: load → play → result. No title screen, no "tap to
begin", no replay menu — the host owns both ends.

| Call | When | Where |
| --- | --- | --- |
| `initializeSDK()` | once, at startup | `src/main.js` top |
| `loadingDone()` | the first interactive frame is on screen | in the update handler |
| `reportResult(score, { flavorText, userData })` | once, when the run ends | `endGame()` |

## Config values

Declared in `public/meta.json`, read with `getConfigValue`. **Always strings**,
including `"false"` — coerce every one.

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `pointsPerTap` | number, 1–100 | `10` | Points per tap on the ball |
| `sound` | boolean | `true` | Sound effects |
| `music` | boolean | `true` | Background music loop |

```
http://localhost:5173/?pointsPerTap=25&music=false
```

## PlayCanvas on iOS, and the User-Agent

The platform docs carry a warning:

> PlayCanvas games currently black-screen on iOS inside the Minit app: the
> WebView's custom User-Agent breaks PlayCanvas's iOS-version detection.

Here is the mechanism, and the repair this template ships at the top of
`index.html`.

The app sets the WebView's **entire** User-Agent to the literal string
`"games.minit.app"` (`DropWebView.config.ts`). PlayCanvas derives its whole
platform model from that string:

```js
platformName = /android/i.test(ua) ? 'android' : /ip(?:[ao]d|hone)/i.test(ua) ? 'ios' : ...
browserName  = /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : ... 'other'
```

Nothing matches, so `platform.name` is `null` and `browserName` is `'other'`.
On iOS that is not a cosmetic mislabel — it is a WebKit renderer with every
WebKit workaround switched off:

```js
const isSafari = platform.browserName === 'safari';          // false in the app
this._tempEnableSafariTextureUnitWorkaround = isSafari;      // skipped
this.supportsImageBitmap = !isSafari && typeof ImageBitmap !== 'undefined';
// → true, and ImageBitmap is exactly the texture path PlayCanvas avoids on WebKit
```

Android is unaffected because `'other'` happens to be right for Chrome, which
matches the docs saying Android is fine.

The shim restores the missing tokens before the engine module is evaluated
(`platform` is computed once, at module top level, so it must be an inline
script ahead of the bundle). It only acts when the UA names no OS at all, and
only when the environment is verifiably Apple WebKit by means the UA cannot
lie about — `navigator.vendor`, the `window.webkit.messageHandlers` bridge, and
touch support. Measured against the app's real User-Agent:

| | `platform.name` | `ios` | `mobile` | `browserName` |
| --- | --- | --- | --- | --- |
| without the shim | `null` | `false` | `false` | `"other"` |
| with the shim | `"ios"` | `true` | `true` | `"safari"` |

**What this does and does not prove.** It fixes the detection, which is the
documented cause. It is verified in Chromium under the app's exact
User-Agent — a real WebKit device is the only place the black screen itself can
be confirmed gone. Test on a device before shipping to iOS players.

## Audio

Identical to the other templates, and identically load-bearing — the repair is
inline at the top of `index.html`. The app replaces every game's `AudioContext`
with a subclass whose `destination` is a mute gain it owns, seeded at `0`, then
states the real volume. Two defects can stop that landing (both DROP-8164): on
iOS the volume message is thrown away by an opaque origin, and the volume is
stated only once at document load, so a context created later is born into a
`0` nobody chose. An explicit `0` is honoured; a `0` we were never addressed
about is repaired after a real gesture.

`npm run package` will not produce a ZIP for a silent build:

```
host never states a volume : 0.22650  (must be audible)
host explicitly mutes      : 0.00000  (must be silent)
```

## Two PlayCanvas gotchas this template already stepped in

**The light type is a string.** `addComponent('light', { type: ... })` wants
`'directional'`, not the `LIGHTTYPE_DIRECTIONAL` constant. Passing the enum
leaves `light._type` invalid and the renderer throws inside its own light
gathering, every frame:

```
TypeError: Cannot read properties of undefined (reading 'push')
    at get splitLights
    at collectDirectionalShadowLights
```

The scene still draws — lit by ambient alone — so it looks like a lighting
setup that needs tuning rather than an exception. Moving the light or raising
its intensity changes nothing, and so does adding a second, correct light: the
first one poisons the pass. Check the console before touching the values.

**`new Application(...)` costs about 800 KB.** The all-in-one constructor
registers every component system and resource handler that exists, none of
which Rollup can then drop: 2.3 MB. Declaring only the systems the scene uses,
via `AppBase` + `AppOptions`, builds the same game at 1.46 MB. The trade is
that `createGraphicsDevice` is async, and top-level `await` is not available at
the Safari 15 target — hence the `boot()` wrapper in `src/main.js`.

## Platform rules this template is built around

Most are enforced by `tools/check-meta.mjs` on every build.

- **Relative asset paths** (`base: './'`). Vite's default absolute `/assets/...`
  resolves to nothing under the app's custom scheme and the page loads blank.
- **No `crossorigin`** on the entry script — its CORS check cannot pass on an
  opaque origin, and the script silently never runs.
- **No network.** The forbidden-API sweep runs against `src/`, not the bundle:
  PlayCanvas ships its own asset loader containing both `fetch` and
  `XMLHttpRequest`, so grepping the bundle would fail every engine-based game
  while proving nothing. `tools/verify-offline.mjs` measures what the running
  game actually requests instead, and fails on anything off-origin.
- **Touch only.** Pointer events throughout, tap targets past 44 px, no hover
  and no keyboard.
- **Portrait, any aspect ratio.** Nothing is hardcoded — the horizon and the
  ball's side and ceiling limits are projected from the camera every frame,
  because how much world fits on screen depends on the field of view, the
  ball's distance and the viewport shape, not on a percentage.
- **Size.** 1.46 MB, 520 KB zipped. Over the "well under 1 MB" guidance and far
  under the 5 MB ceiling; a 3D engine costs what it costs.
