const { test } = require('node:test');
const assert = require('node:assert/strict');
const { keyCode, scale, install } = require('../media/player');

test('small frames retain logical size and large frames fit without changing aspect ratio', () => {
  assert.equal(scale(368, 448, 1024, 1200), 1); // iPad
  assert.equal(scale(368, 448, 390, 650), 1); // iPhone
  assert.equal(scale(368, 448, 320, 600), 320 / 368);
  assert.equal(scale(1280, 720, 390, 650), 390 / 1280); // Rollo
  assert.equal(scale(368, 448, 1024, 1200, 'fit'), 1200 / 448);
});

test('modern keyboard values support navigation, WASD, shift-tab and preserve shortcuts/IME', () => {
  for (const [key, expected] of Object.entries({ ArrowDown: 18, ArrowUp: 17, ArrowLeft: 20, ArrowRight: 19, Enter: 10, Escape: 27, Backspace: 8, Tab: 9, PageUp: 11, Home: 2, End: 3, w: 119, S: 83, b: 98, ' ': 32 })) {
    assert.equal(keyCode({ key, keyCode: 0 }), expected);
  }
  assert.equal(keyCode({ key: 'Tab', shiftKey: true }), 11);
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) assert.equal(keyCode({ key: 'w', [modifier]: true }), 0);
  for (const key of ['Dead', 'Unidentified', 'Shift', 'toString', 'é']) assert.equal(keyCode({ key }), 0);
});

function fixture({ parentOrigin, container, fetcher, screenRuntime = {}, hardwareApi, playerOptions = {} } = {}) {
  const listeners = {}, sent = [], focused = [];
  const env = { innerWidth: 1024, innerHeight: 1200, location: { origin: 'https://preview.test', href: 'https://preview.test/s/session/bundle/revision/index.html' },
    fetch: fetcher, ReadableStream, Response, LVGLGoHardware: hardwareApi,
    parent: { postMessage: (...args) => sent.push(args) },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    MutationObserver: class { observe() {} },
    ResizeObserver: class { constructor(callback) { listeners.containerResize = callback; } observe(element) { assert.equal(element, container); } }
  };
  if (parentOrigin) env.location.hash = '#lvgl-go-parent=' + encodeURIComponent(parentOrigin);
  const keys = [];
  const canvas = { width: 368, height: 448, style: {}, focus: () => focused.push(true), addEventListener: () => {} };
  if (container) canvas.parentElement = container;
  const module = { _lvgl_go_send_key: key => { keys.push(key); return 1; }, ...screenRuntime };
  const player = install(module, canvas, env, playerOptions);
  return { env, listeners, keys, canvas, player, sent, focused, module };
}

test('browser keydown is delivered once; native SDL keypress and keyup are suppressed', () => {
  const { listeners, keys, player, canvas } = fixture();
  let prevented = 0, stopped = 0;
  const event = { key: 's', keyCode: 0, preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ };
  listeners.keydown(event); assert.equal(keys.length, 0);
  player.ready(); assert.equal(canvas.style.width, '368px');
  for (const type of ['keydown', 'keypress', 'keyup']) listeners[type](event);
  assert.deepEqual(keys, [115]); assert.equal(prevented, 3); assert.equal(stopped, 3);
  listeners.keydown({ ...event, target: { closest: () => ({}) } }); // Toolbar/input retains keyboard behavior.
  assert.deepEqual(keys, [115]);
});

test('standalone controls use the shared player directly and ignore window-message commands', () => {
  const reports=[];
  const f=fixture({playerOptions:{report:message=>reports.push(message)}});
  f.player.ready();assert.equal(reports[0].type,'lvgl-go-ready');assert.deepEqual(f.sent,[]);
  f.listeners.message({origin:f.env.location.origin,source:f.env.parent,data:{type:'lvgl-go-key',key:'ArrowDown'}});
  assert.deepEqual(f.keys,[]);
  assert.equal(f.player.handle({type:'lvgl-go-key',key:'ArrowDown'}),true);
  assert.deepEqual(f.keys,[18]);
  f.player.handle({type:'lvgl-go-scale',mode:'fit'});
  assert.equal(parseFloat(f.canvas.style.height),1200);
});

test('Fit follows the rendered container when window measurements lag behind rotation', () => {
  const container = { clientWidth: 844, clientHeight: 322 };
  const { env, listeners, player, canvas } = fixture({ container });
  env.innerWidth = 844;
  env.innerHeight = 301;
  player.ready();
  listeners.message({ origin: env.location.origin, source: env.parent, data: { type: 'lvgl-go-scale', mode: 'fit' } });
  assert.equal(parseFloat(canvas.style.height), 322);
  assert.equal(parseFloat(canvas.style.width), 368 * 322 / 448);
  container.clientHeight = 342;
  listeners.containerResize();
  assert.equal(parseFloat(canvas.style.height), 342);
});

test('iframe accepts focus/scale/keys only from its same-origin parent after initialization', () => {
  const { env, listeners, keys, player, canvas, sent } = fixture();
  player.ready(); assert.equal(sent[0][0].type, 'lvgl-go-ready');
  const message = { origin: env.location.origin, source: env.parent, data: { type: 'lvgl-go-key', key: 'ArrowDown' } };
  listeners.message({ ...message, origin: 'https://evil.test' });
  listeners.message({ ...message, source: {} });
  assert.deepEqual(keys, []);
  listeners.message(message); assert.deepEqual(keys, [18]);
  listeners.message({ ...message, data: { type: 'lvgl-go-scale', mode: 'fit' } });
  assert.equal(parseFloat(canvas.style.height), 1200);
  listeners.message({ ...message, data: { type: 'lvgl-go-scale', mode: 'auto' } });
  assert.equal(canvas.style.width, '368px');
});

test('cross-origin iframe pins keyboard, focus and size messages to its hosted parent', () => {
  const parentOrigin = 'https://go.bauertronix.com.br';
  const { env, listeners, keys, player, canvas, sent } = fixture({ parentOrigin });
  player.ready(); assert.equal(sent[0][1], parentOrigin);
  const message = { origin: parentOrigin, source: env.parent, data: { type: 'lvgl-go-key', key: 'ArrowDown' } };
  listeners.message({ ...message, origin: env.location.origin });
  listeners.message({ ...message, source: {} });
  assert.deepEqual(keys, []);
  listeners.message(message); assert.deepEqual(keys, [18]);
  listeners.message({ ...message, data: { type: 'lvgl-go-scale', mode: 'fit' } });
  assert.equal(parseFloat(canvas.style.height), 1200);
});

test('screen selection stays inside the running module and validates origin, readiness and screen indices', () => {
  let current = 0;
  const selections = [];
  const f = fixture({ parentOrigin: 'https://launcher.test', screenRuntime: {
    _lvgl_go_screen_list: () => 100,
    UTF8ToString: pointer => { assert.equal(pointer, 100); return '["Home","Live view"]'; },
    _lvgl_go_screen_current: () => current,
    _lvgl_go_select_screen: index => { selections.push(index); current = index; return 1; }
  } });
  const message = { origin: 'https://launcher.test', source: f.env.parent, data: { type: 'lvgl-go-select-screen', index: 1 } };
  f.listeners.message(message);
  assert.deepEqual(selections, []);
  f.player.ready();
  assert.deepEqual(f.sent[0], [{ type: 'lvgl-go-ready', screens: ['Home', 'Live view'], current: 0 }, 'https://launcher.test']);
  f.listeners.message({ ...message, origin: 'https://evil.test' });
  f.listeners.message({ ...message, source: {} });
  for (const index of [-1, 2, '1', 0.5, NaN]) f.listeners.message({ ...message, data: { ...message.data, index } });
  assert.deepEqual(selections, []);
  f.listeners.message(message);
  assert.deepEqual(selections, [1]);
  assert.equal(f.sent.at(-1)[0].current, 1);
  f.module.lvglGoScreenChanged(-1); // Project navigation can load a screen outside the runner registry.
  assert.deepEqual(f.sent.at(-1)[0], { type: 'lvgl-go-screen', current: -1 });
});

test('WASM and preload progress counts decoded chunks without buffering the whole response', async () => {
  const base = 'https://preview.test/s/session/bundle/revision/';
  const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetcher = async url => {
    let part = 0;
    const response = new Response(new ReadableStream({ async pull(controller) {
      if (part === 0) { part++; controller.enqueue(bytes.slice(0, 4)); }
      else if (part === 1) { part++; await gate; controller.enqueue(bytes.slice(4)); }
      else controller.close();
    } }), { headers: { 'Content-Type': 'application/wasm', 'Content-Encoding': 'gzip', 'Content-Length': '28' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  const f = fixture({ parentOrigin: 'https://launcher.test', fetcher });
  const response = await f.env.fetch(base + 'index.wasm');
  assert.equal(response.headers.get('content-type'), 'application/wasm');
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, bytes.slice(0, 4), 'First chunk is usable before the rest arrives');
  assert.equal(f.sent.at(-1)[0].loaded,4,'Report the first received chunk even when it arrives immediately after headers');
  release();
  assert.deepEqual((await reader.read()).value, bytes.slice(4));
  assert.equal((await reader.read()).done, true);
  const complete = f.sent.at(-1);
  assert.deepEqual(complete, [{ type: 'lvgl-go-progress', url: base + 'index.wasm', loaded: 8, done: true }, 'https://launcher.test']);
  const wasm = await f.env.fetch(base + 'assets/ui.data');
  assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()), bytes);
  assert.equal(f.sent.at(-1)[0].url, base + 'assets/ui.data');
  await (await f.env.fetch(base + 'lvgl-go-overlay/frame-0.png')).blob();
  assert.equal(f.sent.at(-1)[0].url, base + 'lvgl-go-overlay/frame-0.png');
  assert.equal(f.sent.at(-1)[0].loaded,8);
  assert.equal(f.sent.at(-1)[0].done,true);
  const count = f.sent.length;
  await (await f.env.fetch('https://other.test/another.wasm')).arrayBuffer();
  await (await f.env.fetch(base + 'file.json')).arrayBuffer();
  assert.equal(f.sent.length, count, 'Only this bundle’s WASM/preload/frame downloads are observed');
  f.player.ready();
  assert.equal(f.env.fetch, fetcher, 'Restore the native loader environment after startup');
});

test('player readiness and progress tracking wait for hardware preparation and cannot override an abort', async () => {
  for(const abort of [false,true]) {
    let resolveHardware;
    const hardwareReady=new Promise(resolve=>{resolveHardware=resolve;});
    const fetcher=async()=>new Response();
    const f=fixture({fetcher,hardwareApi:{install:()=>({ready:()=>hardwareReady,fit(){},handle(){}})}});
    const starting=f.player.ready();
    assert(!f.sent.some(([message])=>message.type==='lvgl-go-ready'));
    assert.notEqual(f.env.fetch,fetcher,'Keep tracking frame download bytes after WASM has initialized');
    if(abort)f.player.failed();
    resolveHardware();await starting;
    assert.equal(f.env.fetch,fetcher);
    assert.equal(f.sent.some(([message])=>message.type==='lvgl-go-ready'),!abort);
  }
});

test('download tracking preserves failures and cancellation and restores fetch on runtime abort', async () => {
  let cancelled;
  const failure = new Error('Download interrupted');
  let response;
  const fetcher = async () => response;
  const f = fixture({ fetcher });
  const url = f.env.location.href.replace('index.html', 'index.wasm');
  response = new Response(new ReadableStream({ cancel(reason) { cancelled = reason; } }));
  Object.defineProperty(response, 'url', { value: url });
  await (await f.env.fetch(url)).body.cancel('navigation');
  assert.equal(cancelled, 'navigation');
  response = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
  Object.defineProperty(response, 'url', { value: url });
  await assert.rejects((await f.env.fetch(url)).arrayBuffer(), failure);
  assert(!f.sent.some(([message]) => message.done));
  f.player.failed();
  assert.equal(f.env.fetch, fetcher);
  assert.equal(f.sent.at(-1)[0].type, 'lvgl-go-error');
});


test('display and frame commands share the authenticated parent bridge and observe runtime resolution changes', () => {
  const calls = [];
  const hardware = { handle: data => calls.push(data), ready() {}, fit() {}, sync: () => calls.push('resolution') };
  const f = fixture({ parentOrigin: 'https://launcher.test', hardwareApi: { install: () => hardware } });
  f.player.ready();
  const message = { origin: 'https://launcher.test', source: f.env.parent, data: { type: 'lvgl-go-select-display', index: 1 } };
  f.listeners.message({ ...message, source: {} });
  f.listeners.message({ ...message, origin: 'https://evil.test' });
  assert.deepEqual(calls, []);
  f.listeners.message(message);
  f.listeners.message({ ...message, data: { type: 'lvgl-go-frame', visible: false } });
  assert.deepEqual(calls, [message.data, { type: 'lvgl-go-frame', visible: false }]);
  f.module.lvglGoDisplayChanged(1280, 960);
  assert.equal(calls.at(-1), 'resolution');
});

test('runtime console receives early stdout, LVGL levels, stderr, errors, rejections and aborts', () => {
  const output = [], errors = [];
  const f = fixture({ parentOrigin: 'https://launcher.test', screenRuntime: {
    print: (...args) => output.push(args), printErr: (...args) => errors.push(args)
  } });
  f.module.print('[User] camera ready');
  f.module.print('[Warn] missing asset');
  f.module.print('printf output', 42);
  f.module.printErr('SDL could not create window');
  f.listeners.error({ error: new Error('unreachable WASM trap') });
  f.listeners.unhandledrejection({ reason: new Error('WASM download failed') });
  f.module.printErr('LVGL assertion failed.');
  f.player.failed('Aborted');
  const logs = f.sent.filter(([data]) => data.type === 'lvgl-go-log');
  assert.deepEqual(logs.map(([data]) => data.level), ['user', 'warn', 'info', 'error', 'error', 'error', 'error', 'error']);
  assert.equal(logs[2][0].text, 'printf output 42');
  assert.match(logs[4][0].text, /unreachable WASM trap/);
  assert.match(logs.at(-1)[0].text, /WASM runtime stopped: Aborted/);
  assert(logs.every(([data, origin]) => origin === 'https://launcher.test' && Number.isFinite(data.time)));
  assert.equal(output.length, 3); assert.equal(errors.length, 2);
  assert.equal(f.sent.at(-1)[0].type, 'lvgl-go-error');
  f.module.print('x'.repeat(9000)); assert.equal(f.sent.at(-1)[0].text.length, 8192);
});

test('memory sampling sends exact runtime bytes and stops on page exit or abort without duplicate timers', () => {
  const timers = new Map(); let next = 0;
  const data = { used: 1234, peak: 9876, baseline: 100, blocks: 4, failures: 0, complete: true, pointerBits: 32, colorDepth: 16, bookkeeping: 262144 };
  const f = fixture({ parentOrigin: 'https://launcher.test', screenRuntime: {
    _lvgl_go_memory_snapshot: () => JSON.stringify(data), UTF8ToString: value => value
  } });
  f.env.setInterval = (fn, delay) => { assert.equal(delay, 250); timers.set(++next, fn); return next; };
  f.env.clearInterval = id => timers.delete(id);
  f.player.ready(); assert.equal(timers.size, 1);
  const first = f.sent.find(([message]) => message.type === 'lvgl-go-memory');
  assert.equal(first[0].used, 1234); assert.equal(first[0].peak, 9876); assert.equal(first[1], 'https://launcher.test');
  f.listeners.pageshow(); assert.equal(timers.size, 1);
  f.listeners.pagehide(); assert.equal(timers.size, 0);
  f.listeners.pageshow(); assert.equal(timers.size, 1);
  timers.values().next().value();
  assert.equal(f.sent.filter(([m]) => m.type === 'lvgl-go-memory').length, 2);
  data.failures = 1;
  f.player.failed(); assert.equal(timers.size, 0);
  assert.equal(f.sent.filter(([m]) => m.type === 'lvgl-go-memory').at(-1)[0].failures, 1);
  f.listeners.pageshow(); assert.equal(timers.size, 0);
});

test('a broken memory sampler reports once and cannot restart after a page restore', () => {
  let polls = 0;
  const f = fixture({ screenRuntime: {
    _lvgl_go_memory_snapshot() { polls++; throw new Error('runtime unavailable'); }, UTF8ToString: value => value
  } });
  f.env.setInterval = () => { throw new Error('Sampler must not start after failure'); };
  f.env.clearInterval = () => {};
  f.player.ready(); f.listeners.pageshow(); f.player.failed();
  assert.equal(polls, 1);
  assert.equal(f.sent.filter(([m]) => m.type === 'lvgl-go-memory-stopped').length, 1);
  assert.equal(f.sent.filter(([m]) => m.type === 'lvgl-go-log').length, 1);
});
