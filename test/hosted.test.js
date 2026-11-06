const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { PreviewServer } = require('../dist/server');
const { readConfig } = require('../dist/config');
const session = require('../media/session');
const player = require('../media/player');
const { buildPwa } = require('../scripts/package-pwa');
const appOrigin = 'https://go.bauertronix.com.br';
const remoteOrigin = 'https://desktop-123.trycloudflare.com';
const tokenPath = '/s/' + 'a'.repeat(48) + '/';

test('hosted pairing keeps the PWA origin fixed while the preview hostname changes', () => {
  for (const origin of [remoteOrigin, 'https://another-computer.trycloudflare.com']) {
    const link = appOrigin + '/app/#session=' + encodeURIComponent(origin + tokenPath);
    const parsed = session.parseSession(link, appOrigin);
    assert.equal(parsed.base, origin + tokenPath);
    assert.equal(parsed.origin, origin);
    assert.equal(parsed.sameOrigin, false);
  }
  for (const target of [
    'https://user:secret@desktop.test' + tokenPath,
    'https://desktop.test' + tokenPath + '?secret=bad',
    'https://desktop.test' + tokenPath + '#bad',
    'http://desktop.test' + tokenPath,
    'javascript:alert(1)', '//desktop.test' + tokenPath
  ]) assert.throws(() => session.parseSession(appOrigin + '/app/#session=' + encodeURIComponent(target), appOrigin));
});

test('preview APIs grant only the configured launcher origin and restrict embedding', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-hosted-'));
  const server = new PreviewServer('<title>LVGL Go</title>', 'index.html', { appUrl: appOrigin + '/app/' });
  t.after(async () => { await server.stop(); await rm(tmp, { recursive: true, force: true }); });
  const localBase = await server.start(path.join(tmp, 'sessions'), '127.0.0.1', 0, '127.0.0.1');
  server.setPublicOrigin(remoteOrigin, 'poll');
  assert.equal(new URL(server.pairingUrl).origin, appOrigin);
  assert.equal(session.parseSession(server.pairingUrl, appOrigin).base, server.url);
  const redirect=await fetch(localBase,{redirect:'manual'});
  assert.equal(redirect.status,302);
  assert.equal(redirect.headers.get('location'),server.pairingUrl);
  const response = await fetch(localBase + 'manifest.json', { headers: { Origin: appOrigin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), appOrigin);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal((await response.json()).transport, 'poll');
  assert.equal((await fetch(localBase + 'manifest.json', { headers: { Origin: 'https://evil.test' } })).status, 403);
  const wrong = await fetch(new URL('/s/' + '0'.repeat(48) + '/manifest.json', localBase), { headers: { Origin: appOrigin } });
  assert.equal(wrong.status, 404); assert.equal(wrong.headers.get('access-control-allow-origin'), null);
  const output = path.join(tmp, 'bundle'); await mkdir(output);
  await writeFile(path.join(output, 'index.html'), '<canvas>synthetic fixture</canvas>');
  await writeFile(path.join(output, 'index.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  await server.publish(output);
  const frame = await fetch(localBase + 'bundle/' + server.state.revision + '/index.html');
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-security-policy'), "frame-ancestors 'self' " + appOrigin);
  assert.equal((await fetch(localBase + 'bundle/' + server.state.revision + '/source.c')).status, 404);
});

test('hosted app URL defaults and self-hosted HTTPS addresses are validated', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-app-url-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  assert.equal((await readConfig(tmp, '/extension')).appUrl, appOrigin + '/app/');
  for (const appUrl of ['https://custom.example/app/', 'https://192.168.1.10:8443/app/']) {
    await writeFile(path.join(tmp, 'lvgl-go.json'), JSON.stringify({ appUrl }));
    assert.equal((await readConfig(tmp, '/extension')).appUrl, appUrl);
  }
  for (const appUrl of [false, 'http://unsafe.test/app/', 'https://valid.test/', 'https://u:p@valid.test/app/', 'https://valid.test/app/?bad=1', 'https://valid.test/app/#bad', 'https://valid.test/nested/app/']) {
    await writeFile(path.join(tmp, 'lvgl-go.json'), JSON.stringify({ appUrl }));
    await assert.rejects(readConfig(tmp, '/extension'), /appUrl/);
  }
});

test('large WASM downloads negotiate gzip while preserving MIME, CORS and decoded bytes', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-gzip-'));
  const server = new PreviewServer('<title>LVGL Go</title>', 'index.html', { appUrl: appOrigin + '/app/' });
  t.after(async () => { await server.stop(); await rm(tmp, { recursive: true, force: true }); });
  const base = await server.start(path.join(tmp, 'sessions'), '127.0.0.1', 0, '127.0.0.1');
  const output = path.join(tmp, 'output'); await mkdir(output);
  const wasm = Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.alloc(65536)]);
  await writeFile(path.join(output, 'index.html'), '<canvas></canvas>');
  await writeFile(path.join(output, 'index.wasm'), wasm);
  await mkdir(path.join(output,'lvgl-go-overlay'));
  await writeFile(path.join(output,'lvgl-go-overlay/frame-0.png'),Buffer.alloc(1234));
  await writeFile(path.join(output,'lvgl-go-overlay/manifest.json'),JSON.stringify({version:1,initial:0,targets:[{name:'primary',overlay:{image:'frame-0.png',hidden:false}},{name:'plain'}]}));
  await writeFile(path.join(output,'unrelated.png'),Buffer.alloc(100));
  await server.publish(output);
  assert.deepEqual(server.state.downloadBytes, { 'index.wasm': wasm.length, 'lvgl-go-overlay/frame-0.png':1234 });
  assert.deepEqual((await (await fetch(base + 'manifest.json')).json()).downloadBytes, server.state.downloadBytes);
  assert.deepEqual(server.state.hardware,{initial:0,targets:[{name:'primary',image:'lvgl-go-overlay/frame-0.png',hidden:false},{name:'plain',image:undefined,hidden:false}]});
  const url = base + 'bundle/' + server.state.revision + '/index.wasm';
  const response = await fetch(url, { headers: { Origin: appOrigin, 'Accept-Encoding': 'br, gzip' } });
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(response.headers.get('content-type'), 'application/wasm');
  assert.equal(response.headers.get('access-control-allow-origin'), appOrigin);
  assert.equal(response.headers.get('vary'), 'Origin, Accept-Encoding');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wasm);
  for (const encoding of ['identity', 'gzip;q=0, *;q=1']) {
    const plain = await fetch(url, { headers: { 'Accept-Encoding': encoding } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(Number(plain.headers.get('content-length')), wasm.length);
    assert.deepEqual(Buffer.from(await plain.arrayBuffer()), wasm);
  }
  const head = await fetch(url, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(head.headers.get('content-encoding'), 'gzip');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

async function appFixture(fetcher, options = {}) {
  const html = await readFile(path.join(__dirname, '../media/preview.html'), 'utf8');
  const nodes = new Map(), events = {}, saved = new Map(), history = [], messages = [], watches = [], focusCalls = [], documentEvents = {}, viewportEvents = {}, rootStyle = new Map();
  let clock = 0, nextTimer = 0;
  const timers = new Map();
  const classes = () => { const values = new Set(); return {
    toggle(key, on) { if (on) values.add(key); else values.delete(key); },
    add(key) { values.add(key); }, remove(key) { values.delete(key); }, contains(key) { return values.has(key); }
  }; };
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) nodes.set(id, { style: {}, hidden: false, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, replaceChildren(...children) { this.children = children; }, classList: classes(), addEventListener(name, fn) { events[id + ':' + name] = fn; }, focus() { env.document.activeElement = this; }, contains(target) { return target === this; }, value: '' });
  nodes.get('home').hidden = /<section\b[^>]*\bid="home"[^>]*\bhidden\b/.test(html);
  nodes.get('player').hidden = true;
  nodes.get('ui').focus = () => { focusCalls.push('iframe'); env.document.activeElement = nodes.get('ui'); };
  nodes.get('ui').addEventListener = (name, fn) => { events['ui:' + name] = fn; };
  nodes.get('ui').contentWindow = { postMessage: (...args) => messages.push(args) };
  const env = { URL, URLSearchParams, AbortSignal, AbortController, Date:{now:()=>clock}, console, innerHeight: 844,
    requestAnimationFrame: fn => fn(),
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    visualViewport: { height: 844, addEventListener: (name, fn) => { viewportEvents[name] = fn; } },
    LVGLGoSession: session, LVGLGoPlayer: player, LVGLGoConsole: require('../media/console'), LVGLGoMemory: require('../media/memory'), LVGLGoView: require('../media/view'),
    LVGLGoUpdates: { connectSession:require('../media/updates').connectSession, watchSession(base, transport, update, disconnect) { watches.push({ base, transport, update, disconnect }); return () => {}; } },
    document: { documentElement: { style: { setProperty: (name, value) => rootStyle.set(name, value) } }, createElement: () => ({ attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, focus() { env.document.activeElement = this; } }), getElementById: id => nodes.get(id), body: { classList: classes() }, addEventListener: (name, fn) => { documentEvents[name] = fn; } },
    location: { origin: options.origin || appOrigin, pathname: options.pathname || '/app/', hash: options.hash || '' }, history: { replaceState: (...args) => history.push(args) },
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    navigator: {}, matchMedia: () => ({ matches: options.installed ?? true }), isSecureContext: options.secure ?? true,
    fetch: fetcher, addEventListener: (name, fn) => { events[name] = fn; }
  };
  vm.runInNewContext(await readFile(path.join(__dirname, '../media/app.js'), 'utf8'), env);
  async function connect(base) {
    nodes.get('url').value = base;
    nodes.get('connect').onsubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
  }
  function advance(ms) {
    clock += ms;
    for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
  }
  return { nodes, events, saved, history, messages, watches, connect, focusCalls, documentEvents, env, viewportEvents, rootStyle, advance };
}
const readyState = { protocol: 1, status: 'ready', revision: '1'.repeat(16), entry: 'index.html', transport: 'poll' };

test('launcher is revealed when opened without a pairing link', async () => {
  let requests=0;
  const f=await appFixture(async()=>{requests++;return {ok:true,json:async()=>readyState};});
  assert.equal(f.nodes.get('home').hidden,false);
  assert.equal(f.nodes.get('player').hidden,true);
  assert.equal(requests,0);
});

test('hosted session links open directly into loading and Home still returns to the launcher', async () => {
  let respond;
  const f = await appFixture(() => new Promise(resolve => { respond = resolve; }), {
    hash: '#session=' + encodeURIComponent(remoteOrigin + tokenPath)
  });
  assert.equal(f.nodes.get('home').hidden, true);
  assert.equal(f.nodes.get('player').hidden, false);
  assert.equal(f.nodes.get('back').hidden, false);
  assert.equal(f.nodes.get('loading').hidden, false);
  assert.equal(f.nodes.get('loading-label').textContent, 'Connecting…');
  assert(f.env.document.body.classList.contains('playing'));
  respond({ ok: true, json: async () => readyState });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.nodes.get('home').hidden, true);
  assert.equal(f.nodes.get('loading').hidden, false, 'Keep loading visible until WASM is ready');
  assert(f.nodes.get('ui').src.startsWith(remoteOrigin + tokenPath + 'bundle/'));
  f.events.message({ origin: remoteOrigin, source: f.nodes.get('ui').contentWindow, data: { type: 'lvgl-go-ready' } });
  assert.equal(f.nodes.get('loading').hidden, true);
  f.nodes.get('back').onclick();
  assert.equal(f.nodes.get('home').hidden, false);
  assert.equal(f.nodes.get('player').hidden, true);
  assert.equal(f.history.at(-1)[2], '/app/');
  assert(!f.env.document.body.classList.contains('playing'));
});

test('Home during a pending session connection cancels loading without reopening the preview', async () => {
  let respond;
  const f = await appFixture(() => new Promise(resolve => { respond = resolve; }), {
    hash: '#session=' + encodeURIComponent(remoteOrigin + tokenPath)
  });
  f.nodes.get('back').onclick();
  respond({ ok: true, json: async () => readyState });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.nodes.get('home').hidden, false);
  assert.equal(f.nodes.get('player').hidden, true);
  assert.equal(f.nodes.get('loading').hidden, true);
  assert.equal(f.nodes.get('ui').src, 'about:blank');
  assert.equal(f.history.at(-1)[2], '/app/');
  assert.equal(f.watches.length, 0);
});

test('preview height follows the visible viewport on rotation and return to the app', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => readyState }));
  assert.equal(f.rootStyle.get('--preview-height'), '844px');
  f.env.visualViewport.height = 392.5;
  f.viewportEvents.resize();
  assert.equal(f.rootStyle.get('--preview-height'), '392.5px');
  f.env.visualViewport.height = 0;
  f.env.innerHeight = 430;
  f.events.resize();
  assert.equal(f.rootStyle.get('--preview-height'), '430px');
  f.env.visualViewport.height = 390;
  f.events.pageshow();
  assert.equal(f.rootStyle.get('--preview-height'), '390px');
});

test('LED tracks connection, disconnect, recovery and build errors; pairing stays in the installed PWA', async () => {
  const requests = [];
  const f = await appFixture(async url => { requests.push(url); return { ok: true, json: async () => readyState }; });
  const led = f.nodes.get('connection-led');
  assert(!led.classList.contains('on'));
  await f.connect(remoteOrigin + tokenPath);
  assert.equal(f.nodes.get('back').hidden, false);
  assert.equal(f.nodes.get('brand').href, '/app/');
  assert(led.classList.contains('on'));
  assert.equal(f.nodes.get('connection-label').textContent, 'Connected');
  assert.equal(requests[0], remoteOrigin + tokenPath + 'manifest.json');
  assert.equal(f.saved.get('lvgl-go:last-session'), remoteOrigin + tokenPath);
  assert(f.history.at(-1)[2].startsWith('/app/#session='));
  const iframeUrl = new URL(f.nodes.get('ui').src);
  assert.equal(iframeUrl.origin, remoteOrigin);
  assert.equal(new URLSearchParams(iframeUrl.hash.slice(1)).get('lvgl-go-parent'), appOrigin);
  f.watches[0].update({ ...readyState, status: 'error', message: 'Compile failed' });
  assert(led.classList.contains('on')); // Build health differs from connectivity.
  f.watches[0].disconnect();
  assert(!led.classList.contains('on'));
  assert.equal(f.nodes.get('connection-label').textContent, 'Disconnected');
  f.watches[0].update(readyState); assert(led.classList.contains('on'));
  f.events.offline(); assert(!led.classList.contains('on'));
  f.watches[0].update(readyState);
  f.nodes.get('back').onclick(); assert(!led.classList.contains('on'));
});

test('PWA validates iframe message source and targets the paired preview origin', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => readyState }));
  await f.connect(remoteOrigin + tokenPath);
  const ready = { origin: remoteOrigin, source: f.nodes.get('ui').contentWindow, data: { type: 'lvgl-go-ready' } };
  f.events.message({ ...ready, origin: 'https://evil.test' });
  f.events.message({ ...ready, source: {} });
  assert.equal(f.messages.length, 0);
  f.events.message(ready);
  assert.equal(f.messages.length, 2);
  assert(f.messages.every(([, origin]) => origin === remoteOrigin));
});

test('a temporarily unresolved preview stays connecting and recovers automatically', async () => {
  let attempts=0;
  const f=await appFixture(async()=>{if(++attempts===1)throw new TypeError('Failed to fetch');return {ok:true,json:async()=>readyState};});
  await f.connect(remoteOrigin+tokenPath);
  assert(!f.nodes.get('connection-led').classList.contains('on'));
  assert.equal(f.nodes.get('connection-label').textContent,'Connecting…');
  assert.equal(f.nodes.get('home').hidden,true);
  assert.equal(f.nodes.get('player').hidden,false);
  assert.equal(f.nodes.get('loading').hidden,false);
  assert.equal(f.nodes.get('loading-label').textContent,'Waiting for the preview…');
  assert.match(f.nodes.get('notice').textContent,/Waiting for the preview address/);
  assert.equal(f.nodes.get('reconnect').hidden,false);
  f.advance(1000);await new Promise(resolve=>setImmediate(resolve));
  assert(f.nodes.get('connection-led').classList.contains('on'));
  assert.equal(f.nodes.get('notice').textContent,'');assert.equal(f.watches.length,1);
});

test('a new pairing cancels the previous address retry and prevents stale connection updates',async()=>{
  let oldCalls=0;
  const oldOrigin='https://old-preview.test';
  const f=await appFixture(async url=>{if(url.startsWith(oldOrigin)){oldCalls++;throw new TypeError('Failed to fetch');}return {ok:true,json:async()=>readyState};});
  await f.connect(oldOrigin+tokenPath);assert.equal(oldCalls,1);
  await f.connect(remoteOrigin+tokenPath);
  f.advance(150000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(oldCalls,1);assert.equal(f.watches.length,1);
  assert.equal(f.watches[0].base,remoteOrigin+tokenPath);
  assert.equal(f.nodes.get('notice').textContent,'');
});

test('initial connection timeout leaves LED off with a recoverable message', async () => {
  const f = await appFixture(async () => { throw new Error('Network unavailable'); });
  await f.connect(remoteOrigin + tokenPath);
  f.advance(150000);await new Promise(resolve=>setImmediate(resolve));
  assert(!f.nodes.get('connection-led').classList.contains('on'));
  assert.equal(f.nodes.get('connection-label').textContent, 'Disconnected');
  assert.match(f.nodes.get('notice').textContent, /still unavailable.*Reconnect/);
});

test('loading overlay waits for WASM readiness and returns for each new revision', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => ({ ...readyState, status: 'building', revision: null }) }));
  await f.connect(remoteOrigin + tokenPath);
  const loading = f.nodes.get('loading'), ui = f.nodes.get('ui');
  assert.equal(loading.hidden, true);
  assert.equal(f.nodes.get('waiting').hidden, false);

  f.watches[0].update(readyState);
  assert.equal(loading.hidden, false);
  assert.equal(ui.attributes['aria-busy'], 'true');
  assert.equal(f.nodes.get('waiting').hidden, true);
  f.events['ui:load'](); // The document can load before the WASM runtime is ready.
  assert.equal(loading.hidden, false);
  const ready = { origin: remoteOrigin, source: ui.contentWindow, data: { type: 'lvgl-go-ready' } };
  f.events.message({ ...ready, origin: 'https://evil.test' });
  f.events.message({ ...ready, source: {} });
  assert.equal(loading.hidden, false);
  f.events.message(ready);
  assert.equal(loading.hidden, true);
  assert.equal(ui.attributes['aria-busy'], 'false');

  for (const status of ['building', 'error', 'ready']) {
    f.watches[0].update({ ...readyState, status });
    assert.equal(loading.hidden, true, 'Keep the previous UI visible while building or on failure');
  }
  f.watches[0].update({ ...readyState, revision: '2'.repeat(16) });
  assert.equal(loading.hidden, false);
  f.events.message(ready);
  assert.equal(loading.hidden, true);
  f.watches[0].update({ ...readyState, revision: '3'.repeat(16) });
  assert.equal(loading.hidden, false);
  f.nodes.get('back').onclick();
  assert.equal(loading.hidden, true);
  assert.equal(ui.attributes['aria-busy'], 'false');
  assert.equal(f.nodes.get('waiting').hidden, false);
});

test('screen menu uses authenticated module choices, keeps focus while open and resets on rebuild', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => readyState }));
  await f.connect(remoteOrigin + tokenPath);
  const control = f.nodes.get('screen-control'), trigger = f.nodes.get('screen-select'), menu = f.nodes.get('screen-menu'), ui = f.nodes.get('ui');
  const event = { origin: remoteOrigin, source: ui.contentWindow, data: { type: 'lvgl-go-ready', screens: ['Home', 'Live view', '<literal name>'], current: 1 } };
  assert.equal(control.hidden, true);
  f.events.message({ ...event, origin: 'https://evil.test' });
  assert.equal(control.hidden, true);
  f.events.message(event);
  assert.equal(control.hidden, false);
  assert.equal(menu.children[2].textContent, '<literal name>');
  assert.equal(trigger.textContent, 'Live view');
  assert.equal(menu.children[1].attributes['aria-pressed'], 'true');
  const frames = [];
  f.env.requestAnimationFrame = fn => frames.push(fn);
  const before = f.messages.length;
  f.events['screen-select:pointerdown']();
  f.events.focus();
  frames.shift()();
  assert.equal(f.messages.length, before, 'Do not refocus the frame between touch-down and opening click');
  f.documentEvents.pointerup();
  f.events.focus(); // A delayed window-focus callback must not close a menu opened in the meantime.
  trigger.onclick();
  const selected = f.env.document.activeElement;
  frames.shift()();
  assert.equal(menu.hidden, false);
  assert.equal(f.env.document.activeElement, selected);
  assert.equal(f.messages.length, before);
  f.events.focus(); f.events.pageshow(); f.events['ui:load'](); f.documentEvents.visibilitychange();
  frames.shift()();
  assert.equal(f.messages.length, before, 'Do not send a canvas-focus message while the menu is open');
  assert.equal(f.env.document.activeElement, selected);
  const src = ui.src;
  menu.children[0].onclick();
  assert.equal(menu.hidden, true);
  assert.equal(f.env.document.activeElement, ui);
  assert.equal(ui.src, src, 'Selection does not navigate or download the frame again');
  assert.equal(f.messages.at(-2)[0].type, 'lvgl-go-select-screen');
  assert.equal(f.messages.at(-2)[0].index, 0);
  f.events.message({ ...event, data: { type: 'lvgl-go-screen', current: 0 } });
  assert.equal(trigger.textContent, 'Home');
  assert.equal(menu.children[0].attributes['aria-pressed'], 'true');
  f.events.message({ ...event, data: { type: 'lvgl-go-screen', current: -1 } });
  assert.equal(trigger.textContent, 'Current screen');
  trigger.onclick();
  f.watches[0].update({ ...readyState, revision: '2'.repeat(16) });
  assert.equal(control.hidden, true);
  assert.equal(menu.hidden, true);
  assert.equal(trigger.attributes['aria-expanded'], 'false');
  f.events.message({ ...event, data: { type: 'lvgl-go-ready', screens: ['Only screen'], current: 0 } });
  assert.equal(control.hidden, true);
  f.events.message(event);
  trigger.onclick();
  f.nodes.get('back').onclick();
  assert.equal(control.hidden, true);
  assert.equal(menu.hidden, true);
});

test('screen menu closes explicitly on selection, cancellation and outside interaction', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => readyState }));
  await f.connect(remoteOrigin + tokenPath);
  const trigger = f.nodes.get('screen-select'), menu = f.nodes.get('screen-menu'), ui = f.nodes.get('ui');
  f.events.message({ origin: remoteOrigin, source: ui.contentWindow, data: { type: 'lvgl-go-ready', screens: ['Home', 'Live view'], current: 1 } });
  const src = ui.src;
  trigger.onclick();
  assert.equal(menu.hidden, false);
  assert.equal(trigger.attributes['aria-expanded'], 'true');
  assert.equal(f.nodes.get('screen-dismiss').hidden, false);
  assert.equal(f.rootStyle.get('--player-touch-action'), 'pan-y');
  f.nodes.get('screen-dismiss').onclick();
  assert.equal(menu.hidden, true);
  assert.equal(f.nodes.get('screen-dismiss').hidden, true);
  assert.equal(trigger.attributes['aria-expanded'], 'false');
  assert.equal(f.env.document.activeElement, ui);
  assert.equal(f.rootStyle.get('--player-touch-action'), 'none');
  assert.equal(f.messages.filter(([message]) => message.type === 'lvgl-go-select-screen').length, 0);
  trigger.onclick(); menu.children[1].onclick();
  assert.equal(menu.hidden, true, 'Choosing the current screen also closes the menu');
  assert.equal(f.env.document.activeElement, ui);
  assert.equal(ui.src, src);
  assert.equal(f.messages.at(-2)[0].index, 1);
  trigger.onclick(); f.nodes.get('screen-dismiss').onclick();
  assert.equal(menu.hidden, true);
  assert.equal(f.env.document.activeElement, ui);
  trigger.onclick();
  f.env.document.activeElement = f.nodes.get('scale-fit');
  f.documentEvents.pointerdown({ target: f.nodes.get('scale-fit') });
  assert.equal(menu.hidden, true);
  assert.equal(f.env.document.activeElement, f.nodes.get('scale-fit'), 'Outside controls retain focus');
});

test('screen picker is touch-only and physical keys reach WASM while it is open', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => readyState }));
  await f.connect(remoteOrigin + tokenPath);
  const trigger = f.nodes.get('screen-select'), control = f.nodes.get('screen-control'), menu = f.nodes.get('screen-menu'), ui = f.nodes.get('ui');
  f.events.message({ origin: remoteOrigin, source: ui.contentWindow, data: { type: 'lvgl-go-ready', screens: ['Home', 'Live view'], current: 1 } });
  const targets = [trigger, ...menu.children, f.nodes.get('screen-dismiss')];
  control.contains = target => target === control || target === menu || targets.includes(target);
  targets.forEach(target => { target.closest = () => target; });
  f.env.document.activeElement = trigger;
  trigger.onclick();
  assert.equal(f.env.document.activeElement, trigger, 'Opening does not move focus through screen options');
  assert.equal(trigger.onkeydown, undefined);
  assert.equal(menu.onkeydown, undefined);
  for (const target of targets) {
    for (const key of ['m', 'ArrowDown', 'Enter', ' ', 'Escape']) {
      const count = f.messages.length;
      let prevented = false;
      f.events.keydown({ target, key, preventDefault() { prevented = true; } });
      assert.equal(prevented, true, 'Suppress native button activation and page movement');
      assert.equal(f.messages.length, count + 2);
      assert.equal(f.messages.at(-2)[0].type, 'lvgl-go-focus');
      assert.equal(f.messages.at(-1)[0].type, 'lvgl-go-key');
      assert.equal(f.messages.at(-1)[0].key, key);
      assert.equal(menu.hidden, false, 'Physical keys do not browse or dismiss the screen menu');
    }
  }
  assert.equal(f.messages.filter(([message]) => message.type === 'lvgl-go-select-screen').length, 0);
  menu.children[0].onclick();
  assert.equal(menu.hidden, true);
  assert.equal(f.messages.at(-2)[0].type, 'lvgl-go-select-screen');
  assert.equal(f.env.document.activeElement, ui);
});

test('hardware frame and display controls follow authenticated module state and preserve the running iframe', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => readyState }));
  await f.connect(remoteOrigin + tokenPath);
  const ui = f.nodes.get('ui'), trigger = f.nodes.get('display-select'), menu = f.nodes.get('display-menu'), checkbox = f.nodes.get('frame-toggle');
  const event = { origin: remoteOrigin, source: ui.contentWindow, data: { type: 'lvgl-go-display', targets: [
    { name: 'oled_main', width: 1168, height: 656 }, { name: 'visoflex_2', width: 1280, height: 960 }, { name: 'visoflex_3', width: 1600, height: 1200 }
  ], current: 0, frameAvailable: true, frameVisible: true } };
  assert.equal(f.nodes.get('frame-control').hidden, true);
  f.events.message({ ...event, origin: 'https://evil.test' });
  f.events.message({ ...event, source: {} });
  assert.equal(f.nodes.get('frame-control').hidden, true);
  f.events.message(event);
  assert.equal(f.nodes.get('frame-control').hidden, false);
  assert.equal(f.nodes.get('display-control').hidden, false);
  assert.equal(trigger.textContent, 'oled_main');
  assert.equal(menu.children[1].textContent, 'visoflex_2');
  assert.equal(checkbox.checked, true);
  const src = ui.src;
  checkbox.checked = false; checkbox.onchange();
  assert.equal(f.messages.at(-2)[0].type, 'lvgl-go-frame');
  assert.equal(f.messages.at(-2)[0].visible, false);
  assert.equal(f.env.document.activeElement, ui);
  trigger.onclick();
  const count = f.messages.length;
  f.events.focus(); f.events.pageshow(); f.events['ui:load']();
  assert.equal(f.messages.length, count, 'Keep the custom display menu open during focus events');
  assert.equal(menu.hidden, false);
  const first = menu.children[0];
  f.events.message(event);
  assert.equal(menu.children[0], first, 'Image completion must not rebuild an open target menu');
  menu.children[1].onclick();
  assert.equal(menu.hidden, true);
  assert.equal(f.messages.at(-2)[0].type, 'lvgl-go-select-display');
  assert.equal(f.messages.at(-2)[0].index, 1);
  f.events.message({ ...event, data: { ...event.data, current: 1, frameVisible: false } });
  assert.equal(trigger.textContent, 'visoflex_2');
  assert.equal(checkbox.checked, false);
  f.events.message({ ...event, data: { ...event.data, current: 2, frameAvailable: false, frameVisible: false } });
  assert.equal(trigger.textContent, 'visoflex_3');
  assert.equal(f.nodes.get('frame-control').hidden, true);
  assert.equal(ui.src, src, 'Frame and target changes do not navigate the iframe');
  trigger.onclick();
  f.watches[0].update({ ...readyState, revision: '2'.repeat(16) });
  assert.equal(menu.hidden, true);
  assert.equal(f.nodes.get('display-control').hidden, true);
  assert.equal(f.nodes.get('frame-control').hidden, true);
  f.events.message({ ...event, data: { type: 'lvgl-go-ready', screens: ['Only screen'], current: 0 } });
  assert.equal(f.messages.at(-3)[0].type, 'lvgl-go-frame');
  assert.equal(f.messages.at(-3)[0].visible, false, 'Restore the frame choice after a live rebuild');
  f.events.message(event);
  assert.equal(f.messages.at(-1)[0].type, 'lvgl-go-select-display');
  assert.equal(f.messages.at(-1)[0].index, 2, 'Restore the previous display target after a live rebuild');
});

test('download progress combines WASM and preload bytes and avoids a startup flash on fast loads', async () => {
  const state = { ...readyState, downloadBytes: { 'index.wasm': 2000000, 'assets/ui.data': 1000000 } };
  const f = await appFixture(async () => ({ ok: true, json: async () => state }));
  await f.connect(remoteOrigin + tokenPath);
  const bar = f.nodes.get('loading-progress'), label = f.nodes.get('loading-label');
  const event = { origin: remoteOrigin, source: f.nodes.get('ui').contentWindow };
  const progress = (file, loaded, done = false, revision = state.revision) => ({ ...event, data: { type: 'lvgl-go-progress', url: remoteOrigin + tokenPath + 'bundle/' + revision + '/' + file, loaded, done } });
  assert.equal(bar.hidden, false);
  assert.equal(bar.value, 0);
  assert.equal(label.textContent, 'Downloading UI…');
  for (const forged of [
    { ...progress('index.wasm', 2000000), origin: 'https://evil.test' },
    { ...progress('index.wasm', 2000000), source: {} },
    progress('index.wasm', 2000000, false, '0'.repeat(16)),
    progress('index.wasm', NaN), progress('index.wasm', -1), progress('index.wasm', 2000001),
    progress('other.wasm', 1000)
  ]) f.events.message(forged);
  assert.equal(bar.value, 0);
  f.events.message(progress('index.wasm', 1000000));
  assert.equal(bar.value, 33);
  assert.equal(f.nodes.get('loading-details').textContent, '33% · 1.0 / 3.0 MB');
  f.events.message(progress('index.wasm', 2000000, true));
  f.advance(1000);
  assert.equal(label.textContent, 'Downloading UI…', 'Preload package still downloading');
  f.events.message(progress('assets/ui.data', 1000000, true));
  assert.equal(bar.value, 100);
  f.advance(499);
  assert.equal(label.textContent, 'Downloading UI…');
  f.events.message({ ...event, data: { type: 'lvgl-go-ready' } });
  assert.equal(f.nodes.get('loading').hidden, true);
  f.advance(1000);
  assert.equal(label.textContent, 'Downloading UI…', 'Ready cancels the delayed startup label');

  f.watches[0].update({ ...state, revision: '2'.repeat(16) });
  assert.equal(bar.value, 0);
  f.events.message(progress('index.wasm', 2000000, true));
  assert.equal(bar.value, 0, 'Ignore progress from the previous revision');
  f.events.message(progress('index.wasm', 2000000, true, '2'.repeat(16)));
  f.events.message(progress('assets/ui.data', 1000000, true, '2'.repeat(16)));
  f.advance(300);
  f.events.message(progress('index.wasm', 0, false, '2'.repeat(16))); // Loader retries after a streaming compile failure.
  f.advance(500);
  assert.equal(label.textContent, 'Downloading UI…', 'Retry cancels the pending startup indication');
  f.events.message(progress('index.wasm', 2000000, true, '2'.repeat(16)));
  f.advance(500);
  assert.equal(label.textContent, 'Starting UI…');
  assert.equal(bar.hidden, true);
  assert.equal(f.nodes.get('loading').hidden, false);
  f.events.message({ ...event, data: { type: 'lvgl-go-error' } });
  assert.equal(f.nodes.get('loading').hidden, true);
  assert.equal(f.nodes.get('status').textContent, 'UI failed to load');
});

test('leaving or replacing a loading preview cancels its pending startup indication', async () => {
  const state = { ...readyState, downloadBytes: { 'index.wasm': 1000 } };
  const f = await appFixture(async () => ({ ok: true, json: async () => state }));
  await f.connect(remoteOrigin + tokenPath);
  const finish = revision => f.events.message({ origin: remoteOrigin, source: f.nodes.get('ui').contentWindow,
    data: { type: 'lvgl-go-progress', url: remoteOrigin + tokenPath + 'bundle/' + revision + '/index.wasm', loaded: 1000, done: true } });
  finish(state.revision);
  f.watches[0].update({ ...state, revision: '2'.repeat(16) });
  f.advance(1000);
  assert.equal(f.nodes.get('loading-label').textContent, 'Downloading UI…');
  finish('2'.repeat(16));
  f.nodes.get('back').onclick();
  f.advance(1000);
  assert.equal(f.nodes.get('loading-label').textContent, 'Loading UI…');
  assert.equal(f.nodes.get('loading').hidden, true);
});

test('startup total includes every configured frame from the beginning and stays fixed throughout loading', async () => {
  const state={...readyState,downloadBytes:{'index.wasm':2000000,'lvgl-go-overlay/frame-0.png':4000000,'lvgl-go-overlay/frame-1.png':9000000,'other.png':1000},
    hardware:{initial:0,targets:[{name:'primary',image:'lvgl-go-overlay/frame-0.png',hidden:false},{name:'secondary',image:'lvgl-go-overlay/frame-1.png',hidden:false}]}};
  const f=await appFixture(async()=>({ok:true,json:async()=>state}));
  await f.connect(remoteOrigin+tokenPath);
  const bar=f.nodes.get('loading-progress'),event={origin:remoteOrigin,source:f.nodes.get('ui').contentWindow};
  const progress=(file,loaded,done=false)=>f.events.message({...event,data:{type:'lvgl-go-progress',url:remoteOrigin+tokenPath+'bundle/'+state.revision+'/'+file,loaded,done}});
  assert.equal(f.nodes.get('loading-details').textContent,'0% · 0.0 / 15.0 MB');
  assert.equal(new URL(f.nodes.get('ui').src).hash.includes('lvgl-go-display=primary'),true);
  progress('index.wasm',1000000);assert.equal(bar.value,6);
  assert.match(f.nodes.get('loading-details').textContent,/\/ 15.0 MB$/);
  progress('lvgl-go-overlay/frame-0.png',0);
  assert.equal(bar.value,6,'Starting the image download cannot change the denominator or reduce progress');
  progress('index.wasm',2000000,true);
  assert.equal(bar.value,13);
  f.advance(1000);assert.equal(f.nodes.get('loading-label').textContent,'Downloading UI…');
  progress('other.png',1000,true);assert.equal(bar.value,13);
  progress('lvgl-go-overlay/frame-1.png',9000000,true);assert.equal(bar.value,73,'Other targets contribute to the fixed startup total');
  progress('lvgl-go-overlay/frame-0.png',2000000);assert.equal(bar.value,86);
  progress('lvgl-go-overlay/frame-0.png',4000000,true);assert.equal(bar.value,100);
  assert.equal(f.nodes.get('loading-details').textContent,'100% · 15.0 / 15.0 MB');
  assert.equal(f.nodes.get('loading').hidden,false,'Wait for image decoding after all bytes arrive');
  f.events.message({...event,data:{type:'lvgl-go-ready'}});
  assert.equal(f.nodes.get('loading').hidden,true);
});

test('the startup plan restores display and visibility while counting all frames even when hidden', async () => {
  const state={...readyState,downloadBytes:{'index.wasm':2000000,'lvgl-go-overlay/frame-0.png':4000000,'lvgl-go-overlay/frame-1.png':8000000},
    hardware:{initial:0,targets:[{name:'primary',image:'lvgl-go-overlay/frame-0.png',hidden:false},{name:'secondary',image:'lvgl-go-overlay/frame-1.png',hidden:false}]}};
  const f=await appFixture(async()=>({ok:true,json:async()=>state}));await f.connect(remoteOrigin+tokenPath);
  const event={origin:remoteOrigin,source:f.nodes.get('ui').contentWindow};
  f.events.message({...event,data:{type:'lvgl-go-display',targets:[{name:'primary',width:368,height:448},{name:'secondary',width:1280,height:960}],current:1,frameAvailable:true,frameVisible:true}});
  f.watches[0].update({...state,revision:'2'.repeat(16)});
  assert.equal(f.nodes.get('loading-details').textContent,'0% · 0.0 / 14.0 MB');
  assert.match(new URL(f.nodes.get('ui').src).hash,/lvgl-go-display=secondary/);
  f.nodes.get('frame-toggle').checked=false;f.nodes.get('frame-toggle').onchange();
  f.watches[0].update({...state,revision:'3'.repeat(16)});
  assert.equal(f.nodes.get('loading-details').textContent,'0% · 0.0 / 14.0 MB');
  assert.match(new URL(f.nodes.get('ui').src).hash,/lvgl-go-frame=0/);
});

test('static PWA package contains complete public assets and optional host rules only', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-pwa-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await writeFile(path.join(tmp, 'private.xml'), 'stale source from a previous output');
  await writeFile(path.join(tmp, 'stale.js'), 'stale browser bundle');
  const files = await buildPwa(tmp);
  await assert.rejects(readFile(path.join(tmp, 'private.xml')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(tmp, 'stale.js')), { code: 'ENOENT' });
  for (const file of files) assert((await readFile(path.join(tmp, file))).length > 0);
  assert.equal(await readFile(path.join(tmp,'LICENSE.txt'),'utf8'),await readFile(path.join(__dirname,'../LICENSE.txt'),'utf8'));
  const html = await readFile(path.join(tmp, 'app/index.html'), 'utf8');
  for (const [, url] of html.matchAll(/(?:src|href)="(\/app\/[^"#]*)"/g)) {
    assert(files.includes(url.endsWith('/') ? url.slice(1) + 'index.html' : url.slice(1)), url);
  }
  const manifest = JSON.parse(await readFile(path.join(tmp, 'app/manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) assert(files.includes(icon.src.slice(1)), icon.src);
  const headers = await readFile(path.join(tmp, '_headers'), 'utf8');
  assert.match(headers, /connect-src 'self' https:/);
  assert.match(headers, /frame-src 'self' https:/);
  assert.match(headers, /camera=\(self\)/);
  assert.match(await readFile(path.join(tmp, '_redirects'), 'utf8'), /^\/\s+\/app\/\s+302!/);
  assert(!files.some(file => /\.(wasm|c|h|xml|map)$/.test(file) || /token|\.lvgl-go|node_modules/.test(file)));
});


test('preview focuses automatically on load, return to app and size activation, while dialogs retain input', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => readyState }));
  await f.connect(remoteOrigin + tokenPath);
  for (const event of ['ui:load', 'focus', 'pageshow']) f.events[event]();
  f.documentEvents.visibilitychange();
  f.nodes.get('scale-fit').onclick();
  assert.equal(f.focusCalls.length, 1);
  assert.equal(f.messages.filter(([message]) => message.type === 'lvgl-go-focus').length, 5);
  const count = f.messages.length;
  f.nodes.get('scanner').open = true;
  f.events.focus(); assert.equal(f.messages.length, count);
  f.nodes.get('scanner').open = false;
  f.nodes.get('install-dialog').open = true;
  f.events.focus(); assert.equal(f.messages.length, count);
  f.nodes.get('install-dialog').open = false;
  f.nodes.get('back').onclick(); f.events.focus();
  assert.equal(f.messages.length, count);
});

test('size buttons retain focus until activation and apply Auto/Fit without a native popup or blur handler', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => readyState }));
  await f.connect(remoteOrigin + tokenPath);
  assert(!f.nodes.has('scale'));
  for (const mode of ['fit', 'auto']) {
    const button = f.nodes.get('scale-' + mode);
    f.env.document.activeElement = button;
    const focused = f.focusCalls.length;
    for (const event of ['focus', 'pageshow', 'ui:load']) f.events[event]({ type: event });
    f.documentEvents.visibilitychange();
    assert.equal(f.focusCalls.length, focused);
    assert.equal(f.events['scale-' + mode + ':blur'], undefined);
    button.onclick();
    const [message, origin] = f.messages.at(-2);
    assert.equal(message.type, 'lvgl-go-scale');
    assert.equal(message.mode, mode);
    assert.equal(origin, remoteOrigin);
    assert.equal(f.nodes.get('scale-auto').attributes['aria-pressed'], String(mode === 'auto'));
    assert.equal(f.nodes.get('scale-fit').attributes['aria-pressed'], String(mode === 'fit'));
    assert.equal(f.focusCalls.length, focused + 1);
    assert.equal(f.env.document.activeElement, f.nodes.get('ui'));
    assert.equal(f.messages.at(-1)[0].type, 'lvgl-go-focus');

    // The chosen mode is restored when the iframe signals readiness again.
    f.events.message({ origin: remoteOrigin, source: f.nodes.get('ui').contentWindow, data: { type: 'lvgl-go-ready' } });
    assert.equal(f.messages.at(-2)[0].mode, mode);
  }
});

test('PWA console accepts only paired runtime logs, retains startup output and clears on rebuild', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => readyState }));
  await f.connect(remoteOrigin + tokenPath);
  const event = { origin: remoteOrigin, source: f.nodes.get('ui').contentWindow,
    data: { type: 'lvgl-go-log', level: 'user', text: 'startup marker', time: 1 } };
  f.events.message({ ...event, origin: 'https://evil.test' });
  f.events.message({ ...event, source: {} });
  f.nodes.get('console-toggle').onclick();
  assert.equal(f.nodes.get('console-output').children.length, 0);
  f.nodes.get('console-toggle').onclick();
  f.events.message(event);
  f.nodes.get('console-toggle').onclick();
  assert.equal(f.nodes.get('console-output').children.length, 1);
  assert(f.nodes.get('console-output').children[0].textContent.endsWith('startup marker'));
  f.watches[0].update({ ...readyState, revision: '2'.repeat(16) });
  assert.equal(f.nodes.get('console-output').children.length, 0);
});

test('memory popup rejects forged telemetry, preserves budget editing and resets on a new build', async () => {
  const f = await appFixture(async () => ({ ok: true, json: async () => readyState }));
  await f.connect(remoteOrigin + tokenPath);
  const event = { origin: remoteOrigin, source: f.nodes.get('ui').contentWindow,
    data: { type: 'lvgl-go-memory', used: 1234, peak: 9876, baseline: 100, blocks: 4, failures: 0, complete: true, pointerBits: 32, colorDepth: 16, bookkeeping: 262144, time: 1, screen: -1 } };
  f.nodes.get('memory-toggle').onclick();
  f.events.message({ ...event, origin: 'https://evil.test' }); f.events.message({ ...event, source: {} });
  assert.equal(f.nodes.get('memory-used').textContent, '—');
  f.events.message(event); assert.equal(f.nodes.get('memory-used').textContent, '1,234 B');
  f.env.document.activeElement = f.nodes.get('memory-budget');
  let prevented = false;
  f.events.keydown({ target: f.nodes.get('memory-budget'), key: 'ArrowUp', preventDefault() { prevented = true; } });
  assert.equal(prevented, false); f.events.focus();
  assert.equal(f.env.document.activeElement, f.nodes.get('memory-budget'));
  f.watches[0].update({ ...readyState, revision: '2'.repeat(16) });
  assert.equal(f.nodes.get('memory-used').textContent, '—');
});

test('local HTTP hides unavailable PWA controls and remains connected when internet goes offline', async () => {
  const origin='http://192.168.1.20:54321';
  const f=await appFixture(async()=>({ok:true,json:async()=>({...readyState,transport:'sse'})}),{origin,secure:false,installed:false});
  for(const id of ['scan','install','install-help'])assert.equal(f.nodes.get(id).hidden,true,id);
  await f.connect(origin+tokenPath);
  assert.equal(f.nodes.get('back').hidden,true);
  assert.equal(f.nodes.get('brand').href,tokenPath);
  assert.equal(f.history.at(-1)[2],tokenPath);
  assert.equal(f.watches[0].base,origin+tokenPath);assert.equal(f.watches[0].transport,'sse');
  assert(f.nodes.get('ui').src.startsWith(origin+tokenPath+'bundle/'));
  assert(f.nodes.get('connection-led').classList.contains('on'));
  f.events.offline();assert(f.nodes.get('connection-led').classList.contains('on'));
  f.watches[0].disconnect();assert(!f.nodes.get('connection-led').classList.contains('on'));
  f.watches[0].update(readyState);assert(f.nodes.get('connection-led').classList.contains('on'));
});

test('View retains focus, forwards physical keys and stays open through switches, outside taps and rebuilds', async () => {
  const f=await appFixture(async()=>({ok:true,json:async()=>readyState}));
  await f.connect(remoteOrigin+tokenPath);
  f.events.message({origin:remoteOrigin,source:f.nodes.get('ui').contentWindow,data:{type:'lvgl-go-ready',screens:['screen_one','screen_two'],current:0}});
  const view=f.nodes.get('view-panel'), toggle=f.nodes.get('view-toggle'), memory=f.nodes.get('memory-toggle');
  f.nodes.get('view-controls').contains=target=>[toggle,memory,f.nodes.get('console-toggle'),f.nodes.get('frame-toggle')].includes(target);
  memory.closest=()=>memory;
  f.nodes.get('screen-select').onclick(); assert.equal(f.nodes.get('screen-menu').hidden,false);
  toggle.onclick(); assert.equal(view.hidden,false); assert.equal(f.nodes.get('screen-menu').hidden,true);
  f.env.document.activeElement=toggle;
  f.events.focus(); f.events.pageshow();
  assert.equal(f.env.document.activeElement,toggle,'Window focus must not steal a View interaction');
  let prevented=false;
  const before=f.messages.length;
  f.events.keydown({target:memory,key:'ArrowDown',preventDefault(){prevented=true;}});
  assert.equal(prevented,true); assert.equal(f.messages.length,before+2);
  assert.equal(f.messages.at(-1)[0].type,'lvgl-go-key'); assert.equal(view.hidden,false);
  assert.equal(f.env.document.activeElement,f.nodes.get('ui'));
  memory.onclick();
  assert.equal(view.hidden,false); assert.equal(f.nodes.get('memory-popup').hidden,false);
  assert.equal(memory.attributes['aria-checked'],'true'); assert.equal(f.env.document.activeElement,f.nodes.get('ui'));
  f.documentEvents.pointerdown({target:{}}); assert.equal(view.hidden,false);
  f.nodes.get('screen-select').onclick();
  assert.equal(view.hidden,false); assert.equal(f.nodes.get('screen-menu').hidden,false);
  f.nodes.get('screen-menu').children[1].onclick();
  assert.equal(view.hidden,false); assert.equal(f.rootStyle.get('--player-touch-action'),'pan-y');
  f.watches[0].update({...readyState,revision:'2'.repeat(16)});
  assert.equal(view.hidden,false);
  toggle.onclick(); assert.equal(view.hidden,true);
});

test('every key releases viewer-control focus while mapped keys reach WASM once and the budget remains editable', async () => {
  const f=await appFixture(async()=>({ok:true,json:async()=>readyState}));
  await f.connect(remoteOrigin+tokenPath);
  const ids=['view-toggle','memory-toggle','console-toggle','frame-toggle'];
  const controls=ids.map(id=>f.nodes.get(id));
  f.nodes.get('view-controls').contains=target=>controls.includes(target);
  f.nodes.get('view-toggle').onclick();
  for(const target of controls) {
    target.closest=()=>target;
    for(const key of ['ArrowDown','a','Enter',' ','Tab','Escape','Shift','Control','Alt','Meta','F2']) {
      f.env.document.activeElement=target;
      const before=f.messages.length;let prevented=false,stopped=false;
      f.events.keydown({target,key,preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}});
      assert.equal(f.env.document.activeElement,f.nodes.get('ui'),key+' must leave viewer focus');
      const messages=f.messages.slice(before).map(([data])=>data);
      assert.equal(messages[0].type,'lvgl-go-focus');
      const mapped=!!player.keyCode({key});
      assert.equal(messages.filter(data=>data.type==='lvgl-go-key').length,mapped?1:0,key);
      assert.equal(prevented,mapped);assert.equal(stopped,mapped);
      assert.equal(f.nodes.get('view-panel').hidden,false);
    }
  }
  const budget=f.nodes.get('memory-budget');f.env.document.activeElement=budget;
  const before=f.messages.length;
  f.events.keydown({target:budget,key:'a',preventDefault(){throw Error('Budget editing must remain native');}});
  assert.equal(f.env.document.activeElement,budget);assert.equal(f.messages.length,before);
});

test('local direct addresses open the preview immediately and survive refresh without a fragment', async () => {
  const origin='http://192.168.1.20:54321';
  for(const pathname of [tokenPath,tokenPath+'index.html']) {
    let respond;
    const requests=[];
    const f=await appFixture(url=>{requests.push(url);return new Promise(resolve=>{respond=resolve;});},{origin,secure:false,pathname});
    assert.deepEqual(requests,[origin+tokenPath+'manifest.json']);
    assert.equal(f.nodes.get('home').hidden,true);
    assert.equal(f.nodes.get('player').hidden,false);
    assert.equal(f.nodes.get('back').hidden,true);
    assert.equal(f.nodes.get('loading').hidden,false);
    assert.equal(f.nodes.get('loading-label').textContent,'Connecting…');
    respond({ok:true,json:async()=>({...readyState,transport:'sse'})});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.watches[0].base,origin+tokenPath);
    assert.equal(f.history.at(-1)[2],tokenPath);
    assert.equal(f.nodes.get('brand').href,tokenPath);
    assert.equal(f.nodes.get('home').hidden,true);
    assert(f.nodes.get('ui').src.startsWith(origin+tokenPath+'bundle/'));
  }
});

test('old local QR fragments still open directly and canonicalize to a refreshable session path', async () => {
  const origin='http://192.168.1.20:54321';
  const f=await appFixture(async()=>({ok:true,json:async()=>readyState}),{origin,secure:false,hash:'#session='+encodeURIComponent(tokenPath)});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.nodes.get('home').hidden,true);
  assert.equal(f.nodes.get('back').hidden,true);
  assert.equal(f.history.at(-1)[2],tokenPath);
});

test('a failed direct local session offers a visible connection error and reconnect action', async () => {
  const f=await appFixture(async()=>({ok:false,status:404}),{origin:'http://192.168.1.20:54321',secure:false,pathname:tokenPath});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.nodes.get('home').hidden,false);
  assert.equal(f.nodes.get('player').hidden,true);
  assert.equal(f.nodes.get('loading').hidden,true);
  assert.match(f.nodes.get('notice').textContent,/Session unavailable/);
  assert.equal(f.nodes.get('reconnect').hidden,false);
});
