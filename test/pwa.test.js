const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { X509Certificate } = require('node:crypto');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const { PreviewServer } = require('../dist/server');
const { createDevelopmentCertificate } = require('./helpers/certificates');
const { readConfig } = require('../dist/config');
const { parseSession } = require('../media/session');

function get(url, ca) {
  return new Promise((resolve, reject) => {
    https.get(url, { ca }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('trusted local HTTPS serves installable app assets and pairs with its browser QR decoder', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-pwa-'));
  let server;
  t.after(async () => { await server?.stop(); await rm(tmp, { recursive: true, force: true }); });
  const certs = await createDevelopmentCertificate(path.join(tmp, 'certs'), ['127.0.0.1', '192.168.1.10']);
  const ca = await readFile(certs.ca);
  const leaf = new X509Certificate(await readFile(certs.cert));
  assert(leaf.checkIP('192.168.1.10'));
  assert(leaf.verify(new X509Certificate(ca).publicKey));
  const shell = await readFile(path.join(__dirname, '..', 'media', 'preview.html'), 'utf8');
  server = new PreviewServer(shell, 'index.html', { tls: { cert: await readFile(certs.cert), key: await readFile(certs.key) } });
  const url = await server.start(path.join(tmp, 'published'), '127.0.0.1', 0, '127.0.0.1');
  assert(url.startsWith('https:'));
  const origin = new URL(url).origin;
  const app = await get(server.appUrl, ca);
  assert.equal(app.status, 200);
  assert.match(app.body.toString(), /apple-touch-icon/);
  assert.match(app.headers['content-security-policy'], /frame-src 'self'/);
  const manifestResponse = await get(origin + '/app/manifest.webmanifest', ca);
  assert.equal(manifestResponse.headers['content-type'], 'application/manifest+json');
  const manifest = JSON.parse(manifestResponse.body);
  assert.equal(manifest.id, '/app/');
  assert.equal(manifest.start_url, '/app/');
  assert.equal(manifest.display, 'standalone');
  for (const name of ['app.js', 'player.js', 'console.js', 'memory.js', 'view.js', 'updates.js', 'session.js', 'styles.css', 'qr.js', 'sw.js', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    assert.equal((await get(origin + '/app/' + name, ca)).status, 200, name);
  }
  const startupLinks = [...app.body.toString().matchAll(/rel="apple-touch-startup-image" href="([^"]+)"/g)];
  assert(startupLinks.length > 0);
  for (const [, href] of startupLinks) {
    const image = await get(origin + href, ca);
    assert.equal(image.status, 200, href);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(image.body.subarray(1, 4).toString(), 'PNG');
  }
  for (const href of ['/app/startup-9999x9999.png', '/app/startup-../package.json', '/app/startup-1170x2532.png/private']) {
    assert.equal((await get(origin + href, ca)).status, 404, href);
  }
  assert.equal((await get(origin + '/app/../certs/server-key.pem', ca)).status, 404);
  assert.equal((await get(origin + '/app/root-key.pem', ca)).status, 404);
  const parsed = parseSession(server.pairingUrl, origin);
  assert.equal(parsed.base, url);
  assert.equal(parsed.sameOrigin, true);
  const qr = PNG.sync.read(await QRCode.toBuffer(server.pairingUrl, { width: 500, margin: 4 }));
  assert.equal(jsQR(new Uint8ClampedArray(qr.data), qr.width, qr.height).data, server.pairingUrl);
  const second = await createDevelopmentCertificate(path.join(tmp, 'certs'), ['127.0.0.1']);
  assert.equal(second.fingerprint, certs.fingerprint, 'Renewing the leaf must preserve the trusted CA');
});

test('iOS launch images match portrait and landscape media queries with opaque app backgrounds and a centered icon', async () => {
  const media = path.join(__dirname, '..', 'media');
  const html = await readFile(path.join(media, 'preview.html'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(media, 'manifest.webmanifest'), 'utf8'));
  const links = [...html.matchAll(/rel="apple-touch-startup-image" href="\/app\/([^"]+)" media="([^"]+)"/g)];
  const orientations = new Map();
  for (const [, name, query] of links) {
    const width = Number(query.match(/device-width: (\d+)px/)[1]);
    const height = Number(query.match(/device-height: (\d+)px/)[1]);
    const ratio = Number(query.match(/device-pixel-ratio: (\d+)/)[1]);
    const orientation = query.match(/orientation: (portrait|landscape)/)[1];
    const image = await readFile(path.join(media, name));
    assert.equal(image.readUInt32BE(16), (orientation === 'portrait' ? width : height) * ratio, name);
    assert.equal(image.readUInt32BE(20), (orientation === 'portrait' ? height : width) * ratio, name);
    const key = `${width}x${height}@${ratio}`;
    if (!orientations.has(key)) orientations.set(key, new Set());
    orientations.get(key).add(orientation);
  }
  assert(orientations.has('390x844@3'), 'iPhone portrait and landscape launch coverage');
  assert(orientations.has('820x1180@2'), 'iPad portrait and landscape launch coverage');
  for (const supported of orientations.values()) assert.equal(supported.size, 2);
  const background = [...manifest.background_color.slice(1).matchAll(/../g)].map(value => parseInt(value[0], 16));
  for (const name of ['startup-1170x2532.png', 'startup-2360x1640.png']) {
    const image = PNG.sync.read(await readFile(path.join(media, name)));
    const pixel = (x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
    for (const [x, y] of [[0, 0], [image.width - 1, image.height - 1]]) assert.deepEqual(pixel(x, y), [...background, 255]);
    let iconPixels = 0;
    for (let y = image.height / 2 - 220; y < image.height / 2 + 220; y++) {
      for (let x = image.width / 2 - 220; x < image.width / 2 + 220; x++) {
        const rgba = pixel(x, y);
        assert.equal(rgba[3], 255);
        if (rgba.slice(0, 3).some((value, channel) => value !== background[channel])) iconPixels++;
      }
    }
    assert(iconPixels > 1000, 'The centered icon must be present, not just a solid background');
  }
});

test('PWA session parser handles direct and app links and rejects unsafe or mixed-content links', () => {
  const origin = 'https://192.168.1.10:5173';
  const session = '/s/' + 'a'.repeat(48) + '/';
  assert.equal(parseSession(origin + session, origin).path, session);
  assert.equal(parseSession(origin + '/app/#session=' + encodeURIComponent(session), origin).base, origin + session);
  const other = parseSession('https://other.test/app/#session=' + encodeURIComponent(session), origin);
  assert.equal(other.sameOrigin, false);
  assert.throws(() => parseSession('http://192.168.1.10:5173' + session, origin), /HTTPS/);
  for (const value of ['javascript:alert(1)', 'https://user:password@192.168.1.10:5173' + session, origin + '/app/#session=https://evil.test/', origin + '/s/bad/', origin + session + '?token=bad']) assert.throws(() => parseSession(value, origin));
});

test('service worker caches only public app assets, keeping sessions and WASM out of offline storage', async () => {
  const handlers = {};
  vm.runInNewContext(await readFile(path.join(__dirname, '..', 'media', 'sw.js'), 'utf8'), {
    URL,
    self: { location: { origin: 'https://lvgl.test' }, addEventListener: (event, fn) => { handlers[event] = fn; } },
    fetch: () => Promise.resolve({ ok: false }), caches: {}
  });
  for (const request of [
    { method: 'GET', url: 'https://lvgl.test/s/token/events' },
    { method: 'GET', url: 'https://lvgl.test/s/token/bundle/rev/index.wasm' },
    { method: 'GET', url: 'https://lvgl.test/app/?session=secret' },
    { method: 'GET', url: 'https://other.test/app/' },
    { method: 'POST', url: 'https://lvgl.test/app/' }
  ]) {
    let intercepted = false;
    handlers.fetch({ request, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false);
  }
  for (const url of ['https://lvgl.test/app/', 'https://lvgl.test/app/startup-1170x2532.png']) {
    let intercepted = false;
    handlers.fetch({ request: { method: 'GET', url }, respondWith: () => { intercepted = true; } });
    assert(intercepted);
  }
});

test('configuration uses the managed runtime and rejects obsolete connection and generation options', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-detect-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await mkdir(path.join(tmp, 'sim'));
  await mkdir(path.join(tmp, 'web'));
  await writeFile(path.join(tmp, 'sim', 'CMakeLists.txt'), 'project(desktop C)');
  await writeFile(path.join(tmp, 'web', 'CMakeLists.txt'), 'project(web C)');
  assert((await readConfig(tmp, '/extension')).build[0].args.includes('/extension/runtime'));
  await writeFile(path.join(tmp, 'sim', 'CMakeLists.txt'), 'if(EMSCRIPTEN)\nendif()');
  assert((await readConfig(tmp, '/extension')).build[0].args.includes('/extension/runtime'));
  for (const [config, message] of [
    [{ server: { port: 5173 } }, /Remove server/],
    [{ server: { tls: { cert: 'cert.pem', key: 'key.pem' } } }, /Remove server/],
    [{ tunnel: { enabled: false } }, /Remove tunnel.enabled/],
    [{ generate: { command: 'node', args: [] } }, /Remove generate/]
  ]) {
    await writeFile(path.join(tmp, 'lvgl-go.json'), JSON.stringify(config));
    await assert.rejects(readConfig(tmp, '/extension'), message);
  }
  await writeFile(path.join(tmp, 'lvgl-go.json'), JSON.stringify({ tunnel: { command: '${workspaceFolder}/cloudflared' } }));
  assert.equal((await readConfig(tmp, '/extension')).tunnel.command, path.join(tmp, 'cloudflared'));
});

test('local HTTP pairing supports QR links and browser-history links while HTTPS still rejects HTTP previews', () => {
  const origin='http://192.168.1.20:54321',session='/s/'+'a'.repeat(48)+'/';
  for(const fragment of [session,origin+session]) {
    const parsed=parseSession(origin+'/app/#session='+encodeURIComponent(fragment),origin);
    assert.equal(parsed.base,origin+session);assert.equal(parsed.sameOrigin,true);
  }
  assert.throws(()=>parseSession(origin+'/app/#session='+encodeURIComponent(origin+session),'https://go.bauertronix.com.br'),/HTTPS/);
});

test('HTTP app and preview share one origin and stream local build updates', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'lvgl-go-local-http-'));
  const server=new PreviewServer(await readFile(path.join(__dirname,'../media/preview.html'),'utf8'),'index.html');
  t.after(async()=>{await server.stop();await rm(root,{recursive:true,force:true});});
  await server.start(root,'127.0.0.1',0,'127.0.0.1');
  assert.equal(server.state.transport,'sse');
  assert.equal(server.pairingUrl,server.url);
  assert.equal(new URL(server.pairingUrl).hash,'');
  const parsed=parseSession(server.pairingUrl,new URL(server.appUrl).origin);assert.equal(parsed.base,server.url);
  const app=await fetch(server.appUrl);assert.equal(app.status,200);assert.match(await app.text(),/LVGL Go/);
  for(const link of [server.pairingUrl,server.pairingUrl+'index.html']) {
    const direct=await fetch(link,{redirect:'manual'});
    assert.equal(direct.status,200);assert.equal(direct.headers.get('location'),null);
    assert.equal(direct.headers.get('content-type'),'text/html; charset=utf-8');
    assert.match(direct.headers.get('content-security-policy'),/script-src 'self'/);
    const html=await direct.text();
    assert.match(html,/src="\/app\/app.js"/);
    assert.match(html,/<section\b[^>]*\bid="home"[^>]*\bhidden\b/,'Home must be hidden in the HTTP response, before deferred scripts load');
    const head=await fetch(link,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  }
  const qr=PNG.sync.read(await QRCode.toBuffer(server.pairingUrl,{width:500,margin:4}));
  assert.equal(jsQR(new Uint8ClampedArray(qr.data),qr.width,qr.height).data,server.url);
  const stream=await fetch(server.url+'events',{signal:AbortSignal.timeout(5000)}),reader=stream.body.getReader();
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value),/"status":"idle"/);
    server.setState('building');
    assert.match(new TextDecoder().decode((await reader.read()).value),/"status":"building"/);
  } finally {await reader.cancel();}
});
