const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { InternetTunnel } = require('../dist/tunnel');
const { waitForTunnelReady } = require('../dist/tunnel-readiness');

const origin = 'https://fresh-preview.trycloudflare.com';
const published = () => Response.json({ Status: 0, Answer: [{ type: 1, data: '104.16.230.132' }] });
const pendingDns = () => Response.json({ Status: 3 });
const preview = () => new Response('<title>LVGL Go</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
const unavailableDns = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };

function fixture(fetcher) {
  let clock = 0, id = 0;
  const timers = new Map(), calls = [], logs = [];
  const controller = new AbortController();
  const env = {
    now: () => clock,
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: clock + ms }); return id; },
    clearTimeout: key => timers.delete(key),
    fetch: async (url, options) => { calls.push({ url, at: clock, options }); return fetcher(url, options, clock); }
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const tick = async () => {
    await flush();
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    assert(next, 'Readiness is waiting without a timer');
    const [key, timer] = next; timers.delete(key); clock = timer.at; timer.fn(); await flush();
  };
  const run = async () => {
    let done = false, failure;
    const result = waitForTunnelReady(origin, line => logs.push(line), controller.signal, env).catch(error => { failure = error; }).finally(() => { done = true; });
    await flush();
    for (let steps = 0; !done; steps++) { assert(steps < 300); await tick(); }
    await result; assert.equal(timers.size, 0);
    if (failure) throw failure;
  };
  return { env, logs, calls, timers, controller, run, tick, flush, now: () => clock };
}

test('startup avoids local DNS during publication and settling, tolerates a stale public resolver, and logs readiness', async () => {
  const f = fixture((url, _options, now) => {
    if (url.startsWith(origin)) { assert(now >= 10000); return preview(); }
    if (url.startsWith('https://cloudflare-dns.com')) return pendingDns();
    return now < 4000 ? pendingDns() : published();
  });
  await f.run();
  assert.equal(f.calls.filter(call => call.url.startsWith(origin)).length, 1);
  for (const call of f.calls.filter(call => !call.url.startsWith(origin))) {
    assert.equal(new URL(call.url).searchParams.get('name'), new URL(origin).hostname);
    assert.equal(call.options.headers.Accept, 'application/dns-json');
    assert(!call.url.includes('/s/'));
  }
  assert(f.logs.some(line => /address published/.test(line)));
  assert(f.logs.some(line => /DNS and HTTPS verified/.test(line)));
  assert.equal(f.now(), 10000);
});

test('blocked DNS-over-HTTPS checks fall back after a warm-up without adding configuration', async () => {
  const f = fixture(url => url.startsWith(origin) ? preview() : Promise.reject(new Error('blocked')));
  await f.run();
  const first = f.calls.find(call => call.url.startsWith(origin));
  assert(first.at >= 15000 && first.at <= 20000);
  assert(f.logs.some(line => /Checking through the computer/.test(line)));
});

test('cached public NXDOMAIN answers cannot prevent a working normal connection indefinitely', async () => {
  const f = fixture(url => url.startsWith(origin) ? preview() : pendingDns());
  await f.run();
  assert.equal(f.calls.find(call => call.url.startsWith(origin)).at, 30000);
});

test('DNS publication requires an address record rather than a CNAME or malformed JSON', async () => {
  const f = fixture((url, _options, now) => {
    if (url.startsWith(origin)) return preview();
    if (now >= 12000) return published();
    return url.includes('cloudflare-dns') ? new Response('not json')
      : Response.json({ Status: 0, Answer: [{ type: 5, data: 'alias.example' }, { type: 1, data: 'not an IP' }] });
  });
  await f.run();
  assert.equal(f.calls.find(call => call.url.startsWith(origin)).at, 17000);
});

test('startup retries cached local DNS errors and gateway failures until public HTTPS is ready', async () => {
  const f = fixture((url, _options, now) => {
    if (!url.startsWith(origin)) return published();
    if (now < 110000) return unavailableDns();
    return now < 115000 ? new Response('gateway', { status: 502 }) : preview();
  });
  await f.run();
  assert(f.now() >= 115000 && f.now() < 150000);
  assert(f.logs.some(line => /computer’s DNS/.test(line)));
  assert(f.logs.some(line => /HTTP 502/.test(line)));
  assert(f.logs.some(line => /Retrying automatically/.test(line)));
});

test('stalled HTTPS requests are aborted and startup has a 150-second deadline', async () => {
  let aborted = 0;
  const f = fixture((url, options) => {
    if (!url.startsWith(origin)) return published();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted++; reject(options.signal.reason); }, { once: true }));
  });
  await assert.rejects(f.run(), /still unavailable after 150 seconds/);
  assert(aborted > 1); assert.equal(f.now(), 150000);
});

for (const phase of ['DNS', 'settling', 'HTTPS', 'retry']) test(`canceling startup during ${phase} clears requests and timers`, async () => {
  const f = fixture((url, options) => {
    if ((phase === 'DNS' && !url.startsWith(origin)) || (phase === 'HTTPS' && url.startsWith(origin))) {
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    return url.startsWith(origin) ? unavailableDns() : published();
  });
  const waiting = waitForTunnelReady(origin, line => f.logs.push(line), f.controller.signal, f.env);
  const rejection = assert.rejects(waiting, /canceled/);
  await f.flush();
  if (phase === 'HTTPS' || phase === 'retry') await f.tick();
  const calls = f.calls.length;
  f.controller.abort(new Error('canceled'));
  await rejection; await f.flush();
  assert.equal(f.timers.size, 0); assert.equal(f.calls.length, calls);
  assert(!f.logs.some(line => /DNS and HTTPS verified/.test(line)));
});

for (const ending of ['stop', 'exit', 'readiness failure']) test(`tunnel ${ending} during readiness settles startup and cleans up without a false disconnect`, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-tunnel-'));
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let disconnected = 0, signal, failReadiness, entered;
  const checking = new Promise(resolve => { entered = resolve; });
  child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
  const tunnel = new InternetTunnel(() => {}, () => { disconnected++; }, () => child, async (_origin, _log, abortSignal) => {
    signal = abortSignal; entered();
    await new Promise((_resolve, reject) => { failReadiness = reject; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  });
  t.after(async () => { await tunnel.stop(); await rm(folder, { recursive: true, force: true }); });
  const startup = tunnel.start('cloudflared', 'http://127.0.0.1:50000', folder);
  const rejection = assert.rejects(startup, /canceled|before the public preview was ready|DNS failed/);
  while (!child.stderr.listenerCount('data')) await new Promise(resolve => setImmediate(resolve));
  child.stderr.write('INF https://test.trycloudflare.com\nINF Registered tunnel connection\n');
  await checking;
  if (ending === 'stop') await tunnel.stop();
  else if (ending === 'exit') child.emit('close', 1);
  else failReadiness(new Error('DNS failed'));
  await rejection; await new Promise(resolve => setImmediate(resolve));
  assert(signal.aborted); assert.equal(disconnected, 0);
});
