// Minimal Chrome DevTools Protocol driver. Node 22 ships a global WebSocket, so
// this needs no packages at all -- which matters because the game repo should
// not grow a node_modules just to be verified.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launch({ width = 390, height = 844, dpr = 3, headless = true,
                              autoplay = true } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'molecdp-'));
  const args = [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // SwiftShader: headless Chrome has no GPU here, and Defold needs WebGL.
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--window-size=${width},${height}`, 'about:blank',
  ];
  // Off by default would be truthful, but every existing caller assumes audio
  // just runs. Callers reproducing the Minit app must pass autoplay:false: a
  // WKWebView starts its AudioContext suspended and only a real gesture
  // resumes it, which is the condition this flag papers over.
  if (autoplay) args.splice(1, 0, '--autoplay-policy=no-user-gesture-required');
  if (headless) args.unshift('--headless=new');
  // detached: Chrome spawns renderer/GPU children, and killing only the parent
  // leaves them running. Its own process group lets us reap the whole tree --
  // without this a timed-out run leaks a dozen processes that then thrash the
  // machine and make every later run slower, until nothing completes at all.
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('chrome did not report a debug port')), 30000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(to); resolve(m[0]); }
    });
    proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`chrome exited ${c}: ${buf}`)); });
  });

  // A timed-out or interrupted script never reaches its finally block, so bind
  // the cleanup to process exit as well.
  const reap = () => killTree(proc);
  process.once('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { reap(); process.exit(1); });
  }

  const browser = await connect(wsUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { targetInfo } = await browser.send('Target.getTargetInfo', { targetId });
  const page = await connect(wsUrl.replace(/\/devtools\/browser\/.*$/, `/devtools/page/${targetId}`));

  const logs = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    logs.push({ type: p.type, text: p.args.map(a => a.value ?? a.description ?? '').join(' ') });
  });
  page.on('Runtime.exceptionThrown', (p) => {
    logs.push({ type: 'exception', text: p.exceptionDetails.exception?.description || p.exceptionDetails.text });
  });
  page.on('Log.entryAdded', (p) => logs.push({ type: p.entry.level, text: p.entry.text }));

  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: true,
    screenWidth: width, screenHeight: height,
  });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 10 });

  return {
    page, logs, targetInfo,
    async addInitScript(source) {
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source });
    },
    async setViewport(w, h, scale = dpr) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: scale, mobile: true,
        screenWidth: w, screenHeight: h,
      });
    },
    async goto(url) {
      await page.send('Page.navigate', { url });
    },
    async eval(expression) {
      const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
      return r.result.value;
    },
    // Touch points are CSS pixels, matching what a real finger reports.
    async touch(points, type = 'touchStart') {
      await page.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 12, radiusY: 12, force: 1 })),
      });
    },
    async tap(points, holdMs = 60) {
      await this.touch(points, 'touchStart');
      await new Promise(r => setTimeout(r, holdMs));
      await this.touch([], 'touchEnd');
    },
    async screenshot(path) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, Buffer.from(data, 'base64'));
    },
    async waitForLog(re, timeoutMs = 45000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = logs.find(l => re.test(l.text));
        if (hit) return hit;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for ${re}\n--- logs ---\n${logs.map(l => l.type + ': ' + l.text).join('\n')}`);
    },
    async close() {
      try { page.ws.close(); browser.ws.close(); } catch {}
      killTree(proc);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Kill the browser and every child it spawned. */
function killTree(proc) {
  try { process.kill(-proc.pid, 'SIGKILL'); } catch { }
  try { proc.kill('SIGKILL'); } catch { }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const handlers = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        (handlers.get(msg.method) || []).forEach(fn => fn(msg.params));
      }
    };
    ws.onerror = (e) => reject(new Error('ws error ' + e.message));
    ws.onopen = () => resolve({
      ws,
      send(method, params = {}) {
        const mid = ++id;
        return new Promise((res, rej) => {
          pending.set(mid, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      on(method, fn) {
        if (!handlers.has(method)) handlers.set(method, []);
        handlers.get(method).push(fn);
      },
    });
  });
}
