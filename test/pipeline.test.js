const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm, symlink } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Builder } = require('../dist/builder');
const { PreviewServer } = require('../dist/server');
const { readConfig, shouldWatch } = require('../dist/config');

async function until(predicate, message = 'condition timed out') {
  const end = Date.now() + 8000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

test('pairing, immutable bundles, MIME, failed publication and source isolation', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-server-'));
  const output = path.join(tmp, 'output');
  await mkdir(output);
  await writeFile(path.join(output, 'index.html'), '<canvas>version one</canvas>');
  await writeFile(path.join(output, 'index.wasm'), Buffer.from([0, 97, 115, 109]));
  await mkdir(path.join(output, 'assets'));
  await writeFile(path.join(output, 'assets/ui.data'), Buffer.alloc(1234));
  await writeFile(path.join(output, 'source.c'), 'private source');
  for (const file of ['project.xml', 'ui.h', 'index.js.map', 'library.a', 'lvgl-go.json', 'package.json', 'compile_commands.json']) await writeFile(path.join(output, file), 'private input');
  await mkdir(path.join(output, 'node_modules'));
  await writeFile(path.join(output, 'node_modules', 'private.js'), 'private dependency source');
  await writeFile(path.join(tmp, 'outside.js'), 'private outside');
  if (process.platform !== 'win32') await symlink(path.join(tmp, 'outside.js'), path.join(output, 'linked.js'));
  const server = new PreviewServer('<title>LVGL Go</title>', 'index.html');
  t.after(async () => { await server.stop(); await rm(tmp, { recursive: true, force: true }); });
  const url = await server.start(path.join(tmp, 'published'), '127.0.0.1', 0, '127.0.0.1');
  assert.equal(server.publishedSnapshot(),undefined);
  assert.equal((await fetch(new URL('/', url))).status, 404);
  assert.equal((await fetch(new URL('/s/wrong/manifest.json', url))).status, 404);
  assert.match(await (await fetch(url)).text(), /LVGL Go/);
  const direct = await fetch(url, { redirect: 'manual' });
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get('location'), null);
  assert.equal(server.pairingUrl, url);
  await server.publish(output);
  server.setState('ready');
  const first = await (await fetch(url + 'manifest.json')).json();
  const exportSnapshot=server.publishedSnapshot();
  assert.equal(exportSnapshot.entry,'index.html');
  assert.deepEqual(first.downloadBytes, { 'index.wasm': 4, 'assets/ui.data': 1234 });
  const firstBundle = url + 'bundle/' + first.revision + '/';
  assert.equal((await fetch(firstBundle + 'index.wasm')).headers.get('content-type'), 'application/wasm');
  assert.equal((await fetch(firstBundle + 'source.c')).status, 404);
  for (const file of ['project.xml', 'ui.h', 'index.js.map', 'library.a', 'lvgl-go.json', 'package.json', 'compile_commands.json', 'node_modules/private.js']) assert.equal((await fetch(firstBundle + file)).status, 404, file);
  assert.equal((await fetch(firstBundle + 'linked.js')).status, 404);
  assert.equal((await fetch(firstBundle + '%2e%2e%2foutside.js')).status, 404);
  assert.equal((await fetch(firstBundle + 'index.html', { method: 'POST' })).status, 405);
  await writeFile(path.join(output, 'index.html'), 'version two');
  await writeFile(path.join(output, 'assets/ui.data'), Buffer.alloc(2345));
  assert.match(await (await fetch(firstBundle + 'index.html')).text(), /version one/);
  await server.publish(output);
  const second = await (await fetch(url + 'manifest.json')).json();
  assert.notEqual(server.publishedSnapshot().directory,exportSnapshot.directory);
  assert.match(await readFile(path.join(exportSnapshot.directory,exportSnapshot.entry),'utf8'),/version one/,'An export captures one immutable build while live reload publishes another');
  assert.deepEqual(second.downloadBytes, { 'index.wasm': 4, 'assets/ui.data': 2345 });
  assert.notEqual(second.revision, first.revision);
  assert.equal(await (await fetch(url + 'bundle/' + second.revision + '/index.html')).text(), 'version two');
  await rm(path.join(output, 'index.html'));
  await writeFile(path.join(output, 'assets/ui.data'), Buffer.alloc(3456));
  await assert.rejects(server.publish(output));
  assert.equal(server.state.revision, second.revision);
  assert.deepEqual(server.state.downloadBytes, second.downloadBytes);
  const response = await fetch(url + 'events');
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), new RegExp(second.revision));
  server.setState('building');
  assert.match(new TextDecoder().decode((await reader.read()).value), /building/);
  await reader.cancel();
});

test('build bursts coalesce, changes during builds queue, errors preserve published count', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-builder-'));
  const marker = path.join(tmp, 'runs');
  const fail = path.join(tmp, 'fail');
  let publications = 0;
  const states = [];
  const script = `const fs=require('fs');fs.appendFileSync(process.argv[1],'run\\n');setTimeout(()=>process.exit(fs.existsSync(process.argv[2])?1:0),140);`;
  const builder = new Builder({ debounceMs: 30, build: [{ command: process.execPath, args: ['-e', script, marker, fail] }] },
    () => {}, state => states.push(state), async () => { publications++; });
  t.after(async () => { await builder.stop(); await rm(tmp, { recursive: true, force: true }); });
  builder.request(); builder.request(); builder.request();
  await until(async () => (await readFile(marker, 'utf8').catch(() => '')).includes('run'));
  builder.request(); builder.request();
  await until(() => publications === 1);
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 2);
  await writeFile(fail, 'fail');
  builder.request(true);
  await until(() => states.at(-1) === 'error');
  assert.equal(publications, 1);
  await rm(fail);
  builder.request(true);
  await until(() => publications === 2);
});

test('custom build commands execute in order and referenced environment secrets are redacted', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-commands-'));
  const marker = path.join(tmp, 'generated');
  const logs = [], states = [];
  let publications = 0;
  const secret = 'fake-development-token';
  const previousToken = process.env.LVGL_GO_TEST_SECRET;
  process.env.LVGL_GO_TEST_SECRET = secret;
  t.after(() => { if (previousToken === undefined) delete process.env.LVGL_GO_TEST_SECRET; else process.env.LVGL_GO_TEST_SECRET = previousToken; });
  const builder = new Builder({ debounceMs: 10,
    build: [{ command: process.execPath, args: ['-e', "require('fs').writeFileSync(process.argv[1], 'generated');process.stdout.write(process.argv[2].slice(0,5));setTimeout(()=>process.stdout.write(process.argv[2].slice(5)),20)", marker, '${env:LVGL_GO_TEST_SECRET}'] },
    { command: process.execPath, args: ['-e', "if(require('fs').readFileSync(process.argv[1],'utf8')!=='generated')process.exit(1)", marker] }]
  }, line => logs.push(line), state => states.push(state), async () => { publications++; });
  t.after(async () => { await builder.stop(); await rm(tmp, { recursive: true, force: true }); });
  builder.request(true);
  await until(() => states.at(-1) === 'ready');
  assert.equal(publications, 1);
  assert(!logs.join('\n').includes(secret));
  assert(logs.join('\n').includes('[REDACTED]'));
});

test('stop cancels the compiler and prevents publishing', async t => {
  let publications = 0;
  const states = [];
  const builder = new Builder({ debounceMs: 10, build: [{ command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] }] },
    () => {}, state => states.push(state), async () => { publications++; });
  t.after(() => builder.stop());
  builder.request(true);
  await until(() => states.includes('building'));
  await builder.stop();
  assert.equal(publications, 0);
});

test('configuration resolves paths, defers secrets, ignores build loops and rejects traversal', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-config-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const raw = { projectDir: 'ui', build: [{ command: 'node', args: ['${projectDir}', '${env:BUILD_SECRET}'], cwd: '${workspaceFolder}' }] };
  await writeFile(path.join(tmp, 'lvgl-go.json'), JSON.stringify(raw));
  const config = await readConfig(tmp, '/extension');
  assert.deepEqual(config.build[0].args, [path.join(tmp, 'ui'), '${env:BUILD_SECRET}']);
  assert.equal(config.outputDir, path.join(tmp, '.lvgl-go', 'build', 'bin'));
  for (const file of ['screens/home_gen.c', 'ui.h', 'user_config.cmake', 'images/logo.png', 'project.xml']) assert(shouldWatch(file));
  for (const file of ['screens/home.xml', '.lvgl-go/build/ui_gen.c', 'build/web/lv_conf.h', 'preview-bin/runtime.js', 'node_modules/a.c']) assert(!shouldWatch(file));
  await writeFile(path.join(tmp, 'lvgl-go.json'), JSON.stringify({ ...raw, entry: '../outside.html' }));
  await assert.rejects(readConfig(tmp, '/extension'), /relative HTML/);
});
