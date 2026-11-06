const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readConfig } = require('../dist/config');
const { nearestProject, inspectProject, prepareManagedBuild } = require('../dist/project');
const { InternetTunnel } = require('../dist/tunnel');
const { watchSession, connectSession } = require('../media/updates');
const { resolveLvglLibrary, editorResourcesDirectory } = require('../dist/lvgl');

async function libraryFixture(root, version = '9.5.0', magic = [0, 97, 115, 109], configPath = 'lv_conf.h') {
  const directory = path.join(root, 'v' + version, 'libs');
  const include = path.join(directory, 'include', 'lvgl');
  await mkdir(include, { recursive: true });
  await mkdir(path.join(directory, 'lib'));
  await writeFile(path.join(include, 'lv_version.h'), version.split('.').map((v, i) => '#define LVGL_VERSION_' + ['MAJOR', 'MINOR', 'PATCH'][i] + ' ' + v).join('\n'));
  await writeFile(path.join(include, 'lvgl.h'), '');
  await mkdir(path.dirname(path.join(include, configPath)), { recursive: true });
  await writeFile(path.join(include, configPath), '');
  const member = Buffer.from('lv_obj.c.o/'.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '644'.padEnd(8) + '4'.padEnd(10) + '`\n');
  await writeFile(path.join(directory, 'lib', 'liblvgl.a'), Buffer.concat([Buffer.from('!<arch>\n'), member, Buffer.from(magic)]));
  return directory;
}

test('an open exported project builds without config, sim or web and refreshes its generated metadata', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-managed-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const project = path.join(tmp, 'ui'), cache = path.join(tmp, 'cache');
  await mkdir(path.join(project, 'screens'), { recursive: true });
  // Generated export fixture emitted for the test; existing Editor files remain read-only.
  await writeFile(path.join(project, 'project.xml'), "<project name='example' lvgl_version='9.5.0'><display height='320' width='480'/></project>");
  for (const file of ['CMakeLists.txt', 'file_list_gen.cmake', 'example.h']) await writeFile(path.join(project, file), '');
  await writeFile(path.join(project, 'example_gen.c'), 'home = lv_obj_create(NULL);');
  assert.deepEqual((await inspectProject(project)).permanentScreens, ['home']);
  assert.equal(await nearestProject(path.join(project, 'screens', 'home.xml')), project);
  const config = await readConfig(project, '/extension', cache);
  config.runtime.lvglLibraryDir = await libraryFixture(path.join(tmp, 'resources'));
  assert(config.managedBuild);
  assert.deepEqual(config.tunnel, { command: undefined });
  assert.equal(config.build[0].args[2], '/extension/runtime');
  assert.equal(path.dirname(path.dirname(config.outputDir)), path.join(cache, 'build'));
  assert(config.build[0].args.includes(path.dirname(config.outputDir)));
  await prepareManagedBuild(config);
  assert(config.build[0].args.includes('-DLVGL_LIBRARY_DIR=' + config.runtime.lvglLibraryDir));
  assert(config.build[0].args.includes('-DLVGL_SOURCE_DIR='));
  assert(config.build[0].args.includes('-DUI_WIDTH=480'));
  assert(config.build[0].args.includes('-DUI_HEIGHT=320'));
  assert(config.build[0].args.includes('-DUI_INITIAL_SCREEN=home'));
  const registry = path.join(path.dirname(config.outputDir), 'lvgl_go_screens.h');
  assert(config.build[0].args.includes('-DUI_SCREEN_REGISTRY=' + registry));
  assert.match(await readFile(registry, 'utf8'), /\{ NULL, &home, NULL \}/);
  const inputBefore = await readFile(path.join(project, 'example_gen.c'), 'utf8');
  await writeFile(path.join(project, 'project.xml'), '<project name="example" lvgl_version="9.5.0"><display width="640" height="360"/></project>');
  await prepareManagedBuild(config);
  assert.equal(config.build[0].args.filter(arg => arg.startsWith('-DUI_WIDTH=')).length, 1);
  assert(config.build[0].args.includes('-DUI_WIDTH=640'));
  assert.equal(await readFile(path.join(project, 'example_gen.c'), 'utf8'), inputBefore);
  // A version change in XML must replace cached flags and pick the matching library.
  await writeFile(path.join(project, 'project.xml'), '<project name="example" lvgl_version="v9.6.0"><display width="640" height="360"/></project>');
  assert.equal((await inspectProject(project)).lvglVersion, '9.6.0');
  config.runtime.lvglLibraryDir = await libraryFixture(path.join(tmp, 'resources'), '9.6.0', undefined, 'config/lv_conf.h');
  await prepareManagedBuild(config);
  assert.deepEqual(config.build[0].args.filter(arg => arg.startsWith('-DLVGL_VERSION=')), ['-DLVGL_VERSION=v9.6.0']);
  assert.deepEqual(config.build[0].args.filter(arg => arg.startsWith('-DLVGL_LIBRARY_DIR=')), ['-DLVGL_LIBRARY_DIR=' + config.runtime.lvglLibraryDir]);
  await rm(path.join(project, 'file_list_gen.cmake'));
  await assert.rejects(inspectProject(project), /Generate C in LVGL Pro first/);
});

test('LVGL Pro archive discovery validates version and WASM without downloading', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-library-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const library = await libraryFixture(tmp);
  assert.equal(await resolveLvglLibrary('9.5.0', undefined, tmp), library);
  assert.equal(await resolveLvglLibrary('9.5.0', library), library);
  await assert.rejects(resolveLvglLibrary('9.4.0', library), /does not match/);
  await assert.rejects(resolveLvglLibrary('9.6.0', undefined, tmp), /matching resources/);
  const modern = await libraryFixture(tmp, '9.6.0', undefined, 'config/lv_conf.h');
  assert.equal(await resolveLvglLibrary('9.6.0', undefined, tmp), modern);
  await rm(path.join(modern, 'include/lvgl/config/lv_conf.h'));
  await assert.rejects(resolveLvglLibrary('9.6.0', undefined, tmp), /lv_conf.h/);
  await assert.rejects(resolveLvglLibrary('../9.5.0', undefined, tmp), /Unsupported LVGL version/);
  const native = await libraryFixture(path.join(tmp, 'native'), '9.5.0', [127, 69, 76, 70]);
  await assert.rejects(resolveLvglLibrary('9.5.0', native), /not a WebAssembly archive/);
  assert.equal(editorResourcesDirectory('linux', '/home/test', { XDG_CONFIG_HOME: '/custom' }), '/custom/lvgl-editor/resources');
  assert.equal(editorResourcesDirectory('darwin', '/Users/test', {}), '/Users/test/Library/Application Support/lvgl-editor/resources');
  assert.equal(editorResourcesDirectory('win32', '/test', { APPDATA: '/roaming' }), '/roaming/lvgl-editor/resources');
});

test('CMake builds custom widgets with bundled public/private headers and links separately packaged ThorVG', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-cmake-layout-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const ui = path.join(tmp, 'ui');
  await mkdir(ui);
  await writeFile(path.join(ui, 'CMakeLists.txt'), [
    'add_library(lib-ui STATIC dummy.c)',
    'add_library(lib-ui_user OBJECT dummy.c)',
    'target_link_libraries(lib-ui PUBLIC lvgl)',
    'target_link_libraries(lib-ui_user PUBLIC lvgl)',
    // Build only the UI fixtures with the host compiler, without Emscripten's SDL flag.
    'set_property(TARGET lib-ui lib-ui_user PROPERTY COMPILE_OPTIONS "")', ''
  ].join('\n'));
  const run = promisify(execFile);
  for (const [version, configPath, thorvg] of [
    ['9.5.0', 'lv_conf.h', false], ['9.6.0', 'config/lv_conf.h', true]
  ]) {
    const library = await libraryFixture(tmp, version, undefined, configPath);
    if (version === '9.6.0') {
      await mkdir(path.join(library, 'include/lvgl_private'));
      await writeFile(path.join(library, 'include/lvgl_private/lvgl_private.h'), '#include "lvgl.h"\n');
    }
    await writeFile(path.join(ui, 'dummy.c'), `#include "${version === '9.6.0' ? 'lvgl_private.h' : 'lvgl.h'}"\nvoid dummy(void) {}\n`);
    if (thorvg) await writeFile(path.join(library, 'lib/liblvgl_thorvg.a'), '!<arch>\n');
    await writeFile(path.join(ui, 'project.xml'), `<project name="ui" lvgl_version="${version}"/>`);
    const build = path.join(tmp, 'build-' + version);
    // Host CMake builds the fixture libraries; the imported WASM archives are only inspected.
    await run('cmake', ['-S', path.join(__dirname, '../runtime'), '-B', build, '-G', 'Unix Makefiles',
      '-DEMSCRIPTEN=ON', '-DUI_DIR=' + ui, '-DLVGL_LIBRARY_DIR=' + library]);
    const flags = await readFile(path.join(build, 'CMakeFiles/index.dir/flags.make'), 'utf8');
    assert(flags.includes(path.join(library, 'include/lvgl', configPath)));
    const link = await readFile(path.join(build, 'CMakeFiles/index.dir/link.txt'), 'utf8');
    assert.equal(link.includes('liblvgl_thorvg.a'), thorvg);
    await run('cmake', ['--build', build, '--target', 'lib-ui', 'lib-ui_user']);
  }
});

test('on-demand screens are discovered from compiled exports and selected without changing project sources', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-screens-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await writeFile(path.join(tmp, 'project.xml'), '<project name="ui" lvgl_version="9.5.0"><display width="1168" height="656"/></project>');
  for (const file of ['CMakeLists.txt', 'ui.h', 'ui_gen.c']) await writeFile(path.join(tmp, file), '');
  await mkdir(path.join(tmp, 'screens'));
  const sources = {
    screen_home_Mixed: 'lv_obj_t * screen_home_Mixed_create(void) { return lv_obj_create(NULL); }',
    menu: 'lv_obj_t * menu_create() { return lv_obj_create( NULL ); }',
    component: 'lv_obj_t * component_create(lv_obj_t * parent) { return lv_obj_create(parent); }'
  };
  for (const [name, source] of Object.entries(sources)) await writeFile(path.join(tmp, 'screens', name + '_gen.c'), source);
  // An exported file absent from the compiled source list must not become a choice.
  await writeFile(path.join(tmp, 'screens', 'unused_gen.c'), 'lv_obj_t * unused_create(void) { return lv_obj_create(NULL); }');
  await writeFile(path.join(tmp, 'file_list_gen.cmake'), Object.keys(sources).map(name => '${CMAKE_CURRENT_LIST_DIR}/screens/' + name + '_gen.c').join('\n'));
  const info = await inspectProject(tmp);
  assert.deepEqual(info.screens, ['menu_create', 'screen_home_Mixed_create']);
  assert.deepEqual(info.permanentScreens, []);
  assert.equal(info.initialScreen, undefined);
  const config = await readConfig(tmp, '/extension', path.join(tmp, 'cache'));
  config.runtime.lvglLibraryDir = await libraryFixture(path.join(tmp, 'resources'));
  config.runtime.startScreen = 'menu_create';
  await prepareManagedBuild(config);
  assert(config.build[0].args.includes('-DUI_START_SCREEN=menu_create'));
  assert(config.build[0].args.includes('-DUI_SCREEN_CONSTRUCTORS=menu_create;screen_home_Mixed_create'));
  const registry = path.join(path.dirname(config.outputDir), 'lvgl_go_screens.h');
  const registrySource = await readFile(registry, 'utf8');
  assert.match(registrySource, /\{ screen_home_Mixed_create, NULL, NULL \}/);
  assert.match(registrySource, /\{ menu_create, NULL, NULL \}/);
  assert.match(registrySource, /lv_obj_t \* __wrap_menu_create\(void\)/);
  assert.match(registrySource, /lvgl_go_observe_screen\(screen, menu_create\)/);
  const names = registrySource.match(/lvgl_go_screen_labels\[\] = (.+);/)[1];
  assert.deepEqual(JSON.parse(JSON.parse(names)), ['menu', 'screen_home_Mixed']);
  assert(!registrySource.includes('unused_create'));
  assert(!registrySource.includes('component_create'));
  config.runtime.startScreen = 'screen_home_Mixed_create';
  await prepareManagedBuild(config);
  assert.equal(config.build[0].args.filter(arg => arg.startsWith('-DUI_START_SCREEN=')).length, 1);
  assert(config.build[0].args.includes('-DUI_START_SCREEN=screen_home_Mixed_create'));
  config.runtime.startScreen = 'component_create';
  await assert.rejects(prepareManagedBuild(config), /exported screen constructor/);
  delete config.runtime.startScreen;
  await writeFile(path.join(tmp, 'file_list_gen.cmake'), '${CMAKE_CURRENT_LIST_DIR}/screens/screen_home_Mixed_gen.c');
  await prepareManagedBuild(config);
  assert(config.build[0].args.includes('-DUI_START_SCREEN=screen_home_Mixed_create'));
  assert(!(await readFile(registry, 'utf8')).includes('menu_create'));
  assert(config.build[0].args.includes('-DUI_SCREEN_CONSTRUCTORS=screen_home_Mixed_create'));
  assert.equal(config.build[0].args.filter(arg => arg.startsWith('-DUI_SCREEN_CONSTRUCTORS=')).length, 1);
  for (const [name, source] of Object.entries(sources)) assert.equal(await readFile(path.join(tmp, 'screens', name + '_gen.c'), 'utf8'), source);
});

test('custom build adapters remain explicit and do not receive managed CMake flags', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-custom-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await writeFile(path.join(tmp, 'lvgl-go.json'), JSON.stringify({ build: [{ command: 'custom-builder', args: ['--wasm'] }] }));
  const config = await readConfig(tmp, '/extension');
  await prepareManagedBuild(config);
  assert(!config.managedBuild);
  assert.deepEqual(config.build[0].args, ['--wasm']);
});

test('extension updates use independent CMake caches while one installation reuses its build', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-upgrade-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const project = path.join(tmp, 'ui'), cache = path.join(tmp, 'cache');
  await mkdir(project);
  const oldExtension = path.join(tmp, 'deployedPlugins', 'lvgl-go-0.2.0', 'extension');
  const newExtension = path.join(tmp, 'deployedPlugins', 'lvgl-go-0.3.2', 'extension');
  for (const extension of [oldExtension, newExtension]) {
    await mkdir(path.join(extension, 'runtime'), { recursive: true });
    await writeFile(path.join(extension, 'runtime', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(upgrade_fixture NONE)\n');
  }
  const run = promisify(execFile);
  // Reproduce the legacy shared cache from the user's error without modifying it.
  await run('cmake', ['-S', path.join(oldExtension, 'runtime'), '-B', path.join(cache, 'build')]);
  const legacyCache = path.join(cache, 'build', 'CMakeCache.txt');
  const legacyContents = await readFile(legacyCache, 'utf8');
  assert(legacyContents.includes(path.join(oldExtension, 'runtime')));

  const oldConfig = await readConfig(project, oldExtension, cache);
  const newConfig = await readConfig(project, newExtension, cache);
  const repeatedConfig = await readConfig(project, newExtension, cache);
  assert.notEqual(oldConfig.outputDir, newConfig.outputDir);
  assert.equal(newConfig.outputDir, repeatedConfig.outputDir);
  for (const config of [oldConfig, newConfig, repeatedConfig]) {
    const configure = config.build[0].args;
    await run('cmake', configure.slice(1));
    const buildDir = configure[configure.indexOf('-B') + 1];
    const sourceDir = configure[configure.indexOf('-S') + 1];
    assert.equal(config.outputDir, path.join(buildDir, 'bin'));
    assert(config.build[1].args.includes(buildDir));
    assert((await readFile(path.join(buildDir, 'CMakeCache.txt'), 'utf8')).includes('CMAKE_HOME_DIRECTORY:INTERNAL=' + sourceDir));
  }
  assert.equal(await readFile(legacyCache, 'utf8'), legacyContents);

  // Existing custom adapters keep the historical ${buildDir} expansion.
  await writeFile(path.join(project, 'lvgl-go.json'), JSON.stringify({ build: [{ command: 'cmake', args: ['--build', '${buildDir}'] }] }));
  for (const extension of [oldExtension, newExtension]) {
    const custom = await readConfig(project, extension, cache);
    assert.equal(custom.outputDir, path.join(cache, 'build', 'bin'));
    assert.equal(custom.build[0].args[1], path.join(cache, 'build'));
  }
});

test('poll transport serializes requests, reports new revisions and stops on disconnect', async () => {
  const scheduled = new Map(); let id = 0, calls = 0, errors = 0, state;
  const env = {
    setTimeout: fn => { scheduled.set(++id, fn); return id; }, clearTimeout: key => scheduled.delete(key),
    fetch: async () => ({ ok: true, json: async () => ({ protocol: 1, revision: String(++calls) }) })
  };
  const stop = watchSession('https://example.test/s/token/', 'poll', value => { state = value; }, () => { errors++; }, env);
  const tick = async () => { const [key, fn] = scheduled.entries().next().value; scheduled.delete(key); await fn(); await new Promise(resolve => setImmediate(resolve)); };
  await tick();
  assert.equal(state.revision, '1');
  assert.equal(scheduled.size, 1);
  await tick(); assert.equal(state.revision, '2');
  stop(); assert.equal(scheduled.size, 0); assert.equal(errors, 0);
});

test('SSE failure switches to polling when a tunnel/proxy cannot stream events', async () => {
  let source, queued, fetched = 0, closed = false;
  const env = {
    EventSource: class { constructor() { source = this; } close() { closed = true; } },
    setTimeout: fn => { queued = fn; return 1; }, clearTimeout: () => {},
    fetch: async () => { fetched++; return { ok: true, json: async () => ({ protocol: 1, revision: 'new' }) }; }
  };
  let state;
  const stop = watchSession('https://example.test/s/token/', 'sse', value => { state = value; }, () => {}, env);
  source.onerror(); assert(closed);
  queued(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetched, 1); assert.equal(state.revision, 'new'); stop();
});

test('tunnel waits for connection registration, handles split log chunks and stops its child', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-tunnel-'));
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = false, disconnected = false, ready = false, finishReadiness, checks = 0;
  child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', 0)); return true; };
  const tunnel = new InternetTunnel(() => {}, () => { disconnected = true; }, (_exe, args) => {
    assert(args.includes('http://127.0.0.1:50123'));
    return child;
  }, async () => { checks++; await new Promise(resolve => { finishReadiness = resolve; }); });
  t.after(async () => { await tunnel.stop(); await rm(tmp, { recursive: true, force: true }); });
  const pending = tunnel.start('cloudflared', 'http://127.0.0.1:50123', tmp).then(value => { ready = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  child.stderr.write('INF https://test-tu'); child.stderr.write('nnel.trycloudflare.com\n');
  await new Promise(resolve => setImmediate(resolve)); assert(!ready);
  child.stderr.write('INF Registered tunnel connection connIndex=0\n');
  await new Promise(resolve => setImmediate(resolve)); assert(!ready); assert.equal(checks, 1);
  child.stderr.write('INF Registered tunnel connection connIndex=0\n');
  assert.equal(checks, 1); finishReadiness();
  assert.equal(await pending, 'https://test-tunnel.trycloudflare.com');
  await tunnel.stop(); assert(killed); assert(!disconnected);
  await assert.rejects(new InternetTunnel(() => {}).start('cloudflared', 'http://external.example', tmp), /loopback/);
});

function connectingEnvironment(fetcher) {
  let clock=0,id=0;const timers=new Map();
  const env={Date:{now:()=>clock},AbortController,fetch:(...args)=>fetcher(clock,...args),
    setTimeout:(fn,delay)=>{timers.set(++id,{fn,at:clock+delay});return id;},clearTimeout:id=>timers.delete(id)};
  const tick=async()=>{await new Promise(resolve=>setImmediate(resolve));const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next)return;const [id,timer]=next;timers.delete(id);clock=timer.at;timer.fn();await new Promise(resolve=>setImmediate(resolve));};
  return {env,timers,tick,now:()=>clock};
}

test('initial pairing recovers from DNS and edge failures lasting nearly two minutes',async()=>{
  let attempts=0,retries=0,done=false,result;
  const f=connectingEnvironment(async clock=>{attempts++;if(attempts<=2)return {ok:false,status:502};if(clock<110000)throw new TypeError('Failed to fetch');return {ok:true,json:async()=>({protocol:1,revision:'ready'})};});
  const pending=connectSession('https://preview.test/s/token/',{onRetry:()=>retries++},f.env).then(state=>{done=true;result=state;});
  while(!done)await f.tick();await pending;
  assert.equal(result.revision,'ready');assert(f.now()>=110000&&f.now()<150000);
  assert(attempts>10&&retries===attempts-1);assert.equal(f.timers.size,0);
});

test('initial pairing stops on expired sessions, unsupported protocols, timeout and cancellation',async()=>{
  for(const response of [{ok:false,status:404},{ok:true,json:async()=>({protocol:99})}]) {
    let calls=0;const f=connectingEnvironment(async()=>{calls++;return response;});
    await assert.rejects(connectSession('https://preview.test/s/token/',{},f.env),/Session unavailable|Unsupported preview protocol/);
    assert.equal(calls,1);assert.equal(f.timers.size,0);
  }
  const f=connectingEnvironment(async()=>{throw new TypeError('DNS unavailable');});
  let failure;const timed=connectSession('https://preview.test/s/token/',{},f.env).catch(error=>{failure=error;});
  while(!failure)await f.tick();await timed;
  assert.match(failure.message,/still unavailable/);assert.equal(f.now(),150000);assert.equal(f.timers.size,0);
  const controller=new AbortController(),waiting=connectingEnvironment(async()=>{throw new TypeError('DNS unavailable');});
  const canceled=connectSession('https://preview.test/s/token/',{signal:controller.signal},waiting.env);
  await new Promise(resolve=>setImmediate(resolve));controller.abort();
  await assert.rejects(canceled,/canceled/);assert.equal(waiting.timers.size,0);
  let requestAborted=false;
  const active=connectingEnvironment((_clock,_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{requestAborted=true;reject(new Error('Aborted'));})));
  const activeController=new AbortController(),request=connectSession('https://preview.test/s/token/',{signal:activeController.signal},active.env);
  activeController.abort();await assert.rejects(request,/canceled/);assert(requestAborted);assert.equal(active.timers.size,0);
});
