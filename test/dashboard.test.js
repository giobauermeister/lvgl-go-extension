const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadModule(file, overrides) {
  const filename = path.join(__dirname, '..', 'dist', file + '.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports: module.exports, module,
    require: id => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id),
    __dirname: path.dirname(filename), __filename: filename,
    Buffer, console, setTimeout, clearTimeout
  }, { filename });
  return module.exports;
}

function host({ sidebar = false, failPanel = false } = {}) {
  const commands = new Map(), calls = [], panels = [], errors = [], logs = [];
  const noop = () => ({ dispose() {} });
  function webview() {
    return { options: {}, messages: [], postMessage(message) { this.messages.push(structuredClone(message)); return Promise.resolve(true); },
      onDidReceiveMessage(fn) { this.receive = fn; return noop(); } };
  }
  const view = { webview: webview(), visible: true, shows: 0, show() { this.shows++; }, onDidDispose: noop, onDidChangeVisibility: noop };
  let provider;
  const vscode = {
    StatusBarAlignment: { Left: 1 }, ViewColumn: { Beside: 2 },
    RelativePattern: class {},
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }), joinPath: () => ({}) },
    commands: {
      registerCommand(name, fn) { commands.set(name, fn); return noop(); },
      async executeCommand(name, ...args) {
        calls.push(name);
        if (commands.has(name)) return commands.get(name)(...args);
        if (sidebar && name === 'lvglGo.dashboard.focus') { provider.resolveWebviewView(view); return; }
        throw new Error(`Command with id '${name}' is not registered.`);
      }
    },
    window: {
      activeTextEditor: { document: { uri: { scheme: 'file', fsPath: '/fixture/ui/project.xml' } } },
      createOutputChannel: () => ({ appendLine: line => logs.push(line), show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showErrorMessage: message => { errors.push(message); },
      registerWebviewViewProvider: (_id, value) => { provider = value; return noop(); },
      createWebviewPanel() {
        if (failPanel) throw new Error('Webview panel unavailable');
        const panel = { webview: webview(), reveals: 0, reveal() { this.reveals++; },
          onDidDispose(fn) { this.closed = fn; return noop(); }, dispose() { this.closed?.(); } };
        panels.push(panel); return panel;
      }
    },
    workspace: { isTrusted: true, createFileSystemWatcher: () => ({ dispose() {}, onDidChange: noop, onDidCreate: noop, onDidDelete: noop }) }
  };
  return { vscode, calls, panels, errors, logs, view, commands };
}

function dashboard(h, action = async () => {}) {
  const { Dashboard } = loadModule('dashboard', { vscode: h.vscode });
  return new Dashboard(action);
}

test('dashboard opens one reusable tab directly and exposes only current actions', async () => {
  const h = host(), actions = [];
  const ui = dashboard(h, async name => { actions.push(name); });
  ui.update({ active: true, status: 'Building…', project: '/fixture/ui' });
  await ui.show(); await ui.show();
  assert.equal(h.panels.length, 1);
  assert.deepEqual(h.calls, []); // No host-specific sidebar commands or fallback.
  const webview = h.panels[0].webview;
  await webview.receive({ action: 'ready' });
  assert.equal(webview.messages.at(-1).status, 'Building…');
  ui.update({ status: 'Ready' });
  assert.equal(webview.messages.at(-1).status, 'Ready');
  await webview.receive({ action: 'stop' });
  for (const action of ['config','https','help','generate','token','workbench.action.terminal.new']) await webview.receive({ action });
  assert.deepEqual(actions, ['stop']);
  for (const id of ['config','https','help','revision','generate','token','generation-setup']) assert(!webview.html.includes('id="' + id + '"'));
  ui.dispose(); await ui.show();
  assert.equal(h.panels.length, 2);
});

test('dashboard script binds current controls and reflects session state', async () => {
  const h = host(), ui = dashboard(h), nodes = new Map();
  await ui.show(); const webview = h.panels[0].webview;
  for (const [,id] of webview.html.matchAll(/id="([^"]+)"/g)) nodes.set(id, { removeAttribute() {} });
  let receive;
  vm.runInNewContext(webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
    acquireVsCodeApi: () => ({ postMessage: message => webview.receive(message) }),
    document: { getElementById: id => nodes.get(id) },
    addEventListener: (name, fn) => { if (name === 'message') receive = fn; }
  });
  receive({ data: webview.messages.at(-1) });
  ui.update({ active: true });
  receive({ data: webview.messages.at(-1) });
  assert.equal(typeof nodes.get('start').onclick, 'function');
  assert.equal(nodes.get('start').hidden, true);
  assert.equal(nodes.get('export').disabled,true);
  assert.equal(nodes.get('stop').hidden, false);
  assert.equal(nodes.get('connection-label').textContent, 'Disconnected');
  ui.update({ active: true, connected: true, status: 'Building…', project: '/fixture/menu_nav_ui' });
  receive({ data: webview.messages.at(-1) });
  assert.equal(nodes.get('connection-label').textContent, 'Connected');
  assert.equal(nodes.get('connection-led').className, 'led on');
  assert.equal(nodes.get('status').textContent, 'Building…');
  assert.equal(nodes.get('project').textContent, 'menu_nav_ui');
  assert.equal(nodes.get('project-path').textContent, '/fixture/menu_nav_ui');
  ui.update({ status: 'Build failed' });
  receive({ data: webview.messages.at(-1) });
  assert.equal(nodes.get('connection-led').className, 'led on');
  assert.equal(nodes.get('status').className, 'build-status error');
  ui.update({canExport:true});receive({data:webview.messages.at(-1)});
  assert.equal(nodes.get('export').disabled,false,'The latest successful snapshot remains exportable after a later build failure');
  ui.update({ connected: false, status: 'Ready' });
  receive({ data: webview.messages.at(-1) });
  assert.equal(nodes.get('connection-label').textContent, 'Disconnected');
  assert.equal(nodes.get('connection-led').className, 'led');
  ui.update({ active: false, connected: false, status: 'Stopped' });
  receive({ data: webview.messages.at(-1) });
  assert.equal(nodes.get('connection-label').textContent, 'Not running');
  assert.equal(nodes.get('export').disabled,true);
  assert.equal(nodes.get('start').hidden, false);
  assert.equal(nodes.get('stop').hidden, true);
});

test('Activity Bar dashboard receives actions and state without opening an editor tab', async () => {
  const h = host(), actions = [], ui = dashboard(h, async name => { actions.push(name); });
  h.view.title = 'Preview';
  ui.resolveWebviewView(h.view);
  assert.equal(h.view.title, 'LVGL Go', 'Override the title of an existing sidebar view');
  await ui.show(); await ui.show();
  await h.view.webview.receive({ action: 'start' });
  await h.view.webview.receive({ action: 'stop' });
  ui.update({ status: 'Ready' });
  assert.equal(h.view.webview.messages.at(-1).status, 'Ready');
  assert.deepEqual(actions, ['start', 'stop']);
  assert.equal(h.panels.length, 0);
  assert.equal(h.view.shows, 2);
  assert.deepEqual(h.calls, []);
});

for (const mode of ['tab', 'sidebar', 'panel-failure', 'screen-selection', 'screen-cancel', 'tunnel-readiness']) test(`session uses the automatic hosted-app flow (${mode})`, async () => {
  const failPanel = mode === 'panel-failure';
  const h = host({ failPanel, sidebar: mode === 'sidebar' });
  const { Dashboard } = loadModule('dashboard', { vscode: h.vscode });
  let started = 0, stopped = 0, builds = 0, tunnels = 0, disconnected, buildState, picks = 0;
  let liveServer,exported=0,destination;const savedFiles=[];
  let releaseTunnel, enteredTunnel;
  const tunnelGate = new Promise(resolve => { releaseTunnel = resolve; });
  const tunnelEntered = new Promise(resolve => { enteredTunnel = resolve; });
  h.vscode.ProgressLocation={Notification:1};
  h.vscode.window.showSaveDialog=async()=>destination;
  h.vscode.window.withProgress=async(_options,task)=>task();
  h.vscode.window.showInformationMessage=()=>{};
  h.vscode.workspace.fs={writeFile:async(uri,bytes)=>savedFiles.push({uri,bytes})};
  const choosingScreen = mode.startsWith('screen-'), saved = new Map(), configs = [];
  h.vscode.window.showQuickPick = async items => { picks++; return mode === 'screen-cancel' ? undefined : items[picks === 1 ? 1 : 0]; };
  const extension = loadModule('extension', {
    vscode: h.vscode, './dashboard': { Dashboard },
    './export':{exportHtml:async(snapshot,_extension,project)=>{exported++;assert.equal(snapshot.directory,'/fixture/snapshot');assert.equal(project,'ui');return Buffer.from('<html>shared</html>');}},
    'node:fs/promises': { mkdir: async () => {}, readFile: async () => '<title>Fixture</title>' },
    './project': { nearestProject: async () => '/fixture/ui', prepareManagedBuild: async () => {}, inspectProject: async () => ({ screens: choosingScreen ? ['home_create', 'menu_create'] : [] }) },
    './config': { readConfig: async () => { const config = { projectDir: '/fixture/ui', managedBuild: true, runtime: {}, outputDir: '/fixture/build/bin', entry: 'index.html', appUrl: 'https://go.bauertronix.com.br/app/', tunnel: {} }; configs.push(config); return config; } },
    './server': { PreviewServer: class {
      constructor() { liveServer=this;this.state = { revision: null }; this.pairingUrl = 'https://go.bauertronix.com.br/app/#session=fixture'; this.localOrigin = 'http://127.0.0.1:1234'; }
      publishedSnapshot(){return this.state.revision?{directory:'/fixture/snapshot',entry:'index.html'}:undefined;}
      async start() { started++; }
      async stop() { stopped++; }
      setState() {}
      setPublicOrigin() {}
    } },
    './tunnel': { ensureCloudflared: async () => 'fixture-cloudflared', InternetTunnel: class {
      constructor(log, onDisconnect) { this.log = log; disconnected = onDisconnect; }
      async start() { tunnels++; enteredTunnel(); if (mode === 'tunnel-readiness') { this.log('Waiting for preview address DNS publication…'); await tunnelGate; } return 'https://fixture.trycloudflare.com'; }
      async stop() { tunnels--; }
    } },
    './builder': { Builder: class { constructor(_config, _log, onState) { buildState = onState; } request() { builds++; } async stop() {} } }
  });
  extension.activate({ subscriptions: [], globalStorageUri: { fsPath: '/fixture/cache' }, extensionPath: '/extension', globalState: { get: (_key, fallback) => fallback, update: async () => {} }, workspaceState: { get: key => saved.get(key), update: async (key, value) => { saved.set(key, value); } } });
  if (mode === 'sidebar') {
    await h.vscode.commands.executeCommand('lvglGo.dashboard.focus');
  }
  for (const name of ['lvglGo.init','lvglGo.setupHttps','lvglGo.generateAndBuild','lvglGo.setToken']) assert(!h.commands.has(name));
  const startup = h.commands.get('lvglGo.start')();
  if (mode === 'tunnel-readiness') {
    await tunnelEntered;
    const waiting = h.panels[0].webview.messages.at(-1);
    assert.equal(waiting.connected, false); assert.equal(waiting.active, false);
    assert.equal(waiting.busy, true); assert.equal(waiting.url, ''); assert.equal(waiting.qr, '');
    assert.equal(waiting.status, 'Connecting…'); assert.equal(builds, 0);
    assert(h.logs.some(line => line.includes('Waiting for preview address DNS publication')));
    releaseTunnel();
  }
  await startup;
  if (failPanel) {
    assert.equal(started, 0); assert.equal(builds, 0); assert.equal(tunnels, 0);
    assert.equal(h.errors.length, 1); return;
  }
  if (mode === 'screen-cancel') {
    assert.equal(started, 0); assert.equal(tunnels, 0); assert.equal(builds, 0);
    assert.equal(h.errors.length, 0); assert.equal(picks, 1); return;
  }
  assert.equal(started, 1); assert.equal(builds, 1); assert.equal(stopped, 0); assert.equal(tunnels, 1);
  assert.equal(h.errors.length, 0);
  assert(h.logs.some(line => line.includes('Pair device')));
  assert(!h.logs.some(line => line.includes('no sim/ required')));
  const panelsBefore = h.panels.length;
  assert.equal(panelsBefore, mode === 'sidebar' ? 0 : 1);
  const webview = mode === 'sidebar' ? h.view.webview : h.panels[0].webview;
  assert.equal(webview.messages.at(-1).canChooseScreen, choosingScreen);
  if (choosingScreen) assert.equal(configs[0].runtime.startScreen, 'menu_create');
  assert.equal(webview.messages.at(-1).connected, true);
  if(mode==='tab') {
    await h.commands.get('lvglGo.exportHtml')();assert.match(h.errors.pop(),/first successful WASM build/);
    liveServer.state.revision='1'.repeat(16);buildState('ready');
    assert.equal(webview.messages.at(-1).canExport,true);
    assert.equal(webview.messages.at(-1).status,'Ready');
    assert.equal(webview.messages.at(-1).message,'','Ready belongs in the existing Build badge without adding a notice row');
    await h.commands.get('lvglGo.exportHtml')();assert.equal(exported,0,'Canceling Save must not export');
    destination=h.vscode.Uri.file('/fixture/shared.html');
    await h.commands.get('lvglGo.exportHtml')();
    assert.equal(exported,1);assert.equal(savedFiles[0].uri.fsPath,'/fixture/shared.html');
    assert.equal(savedFiles[0].bytes.toString(),'<html>shared</html>');
  }
  buildState('error', 'Fixture compile failed');
  assert.equal(webview.messages.at(-1).message,'Fixture compile failed');
  assert.equal(webview.messages.at(-1).connected, true);
  disconnected();
  assert.equal(webview.messages.at(-1).connected, false);
  buildState('ready');
  assert.equal(webview.messages.at(-1).connected, false);
  await h.commands.get('lvglGo.start')(); assert.equal(started, 1);
  await h.commands.get('lvglGo.stop')(); assert.equal(stopped, 1); assert.equal(tunnels, 0);
  assert.equal(h.panels.length, panelsBefore);
  assert.equal(webview.messages.at(-1).connected, false);
  if (choosingScreen) {
    await h.commands.get('lvglGo.start')();
    assert.equal(picks, 1);
    assert.equal(configs[1].runtime.startScreen, 'menu_create');
    const before = builds;
    await h.commands.get('lvglGo.selectScreen')();
    assert.equal(configs[1].runtime.startScreen, 'home_create');
    assert.equal(builds, before + 1);
    assert.equal(saved.get('startScreen:/fixture/ui'), 'home_create');
    await h.commands.get('lvglGo.stop')();
  }
});

test('local checkbox validates boolean messages and reflects active/busy state', async () => {
  const h = host(), actions = [], ui = dashboard(h, async (name, checked) => actions.push([name, checked]));
  await ui.show(); const webview = h.panels[0].webview;
  await webview.receive({action:'ready'});
  assert.equal(webview.messages.at(-1).localNetwork, false);
  for (const checked of ['true', 1, null, undefined]) await webview.receive({ action:'local', checked });
  assert.deepEqual(actions, []);
  await webview.receive({ action:'local', checked:true });
  assert.deepEqual(actions, [['local',true]]);
  const nodes = new Map(); let receive;
  for (const [,id] of webview.html.matchAll(/id="([^"]+)"/g)) nodes.set(id, { removeAttribute() {} });
  vm.runInNewContext(webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
    acquireVsCodeApi: () => ({ postMessage: message => webview.receive(message) }),
    document: { getElementById:id=>nodes.get(id) }, addEventListener: (_event,fn)=>{receive=fn;}
  });
  ui.update({ localNetwork:true,active:false,busy:false }); receive({data:webview.messages.at(-1)});
  assert.equal(nodes.get('local').checked,true); assert.equal(nodes.get('local').disabled,false);
  assert.match(nodes.get('pair-hint').textContent,/phone’s camera/);
  ui.update({active:true}); receive({data:webview.messages.at(-1)}); assert.equal(nodes.get('local').disabled,true);
  ui.update({active:false,busy:true}); receive({data:webview.messages.at(-1)}); assert.equal(nodes.get('local').disabled,true);
});

for (const mode of ['switch', 'remembered', 'multiple', 'no-address', 'cancel']) test(`local HTTP session (${mode}) skips the tunnel and manages the selected LAN address`, async () => {
  const h=host(), { Dashboard }=loadModule('dashboard',{vscode:h.vscode});
  const saved=new Map(mode==='remembered'?[['localNetwork',true]]:[]), started=[], options=[], opened=[], copied=[];
  let ensured=0,tunnels=0,stopped=0,builds=0,picks=0;
  h.vscode.env={clipboard:{writeText:async url=>copied.push(url)},openExternal:async uri=>opened.push(uri.href)};
  h.vscode.Uri.parse=href=>({href});
  h.vscode.window.showQuickPick=async items=>{picks++;return mode==='cancel'?undefined:items[1];};
  const addresses=mode==='no-address'?[]:mode==='multiple'||mode==='cancel'?[{name:'eth0',address:'192.168.1.20'},{name:'wlan0',address:'10.0.0.30'}]:[{name:'eth0',address:'192.168.1.20'}];
  const extension=loadModule('extension',{
    vscode:h.vscode,'./dashboard':{Dashboard},
    'node:fs/promises':{mkdir:async()=>{},readFile:async()=>'<title>Fixture</title>'},
    './network':{localAddresses:()=>addresses},
    './project':{nearestProject:async()=>'/fixture/ui',inspectProject:async()=>({screens:[]}),prepareManagedBuild:async()=>{}},
    './config':{readConfig:async()=>({projectDir:'/fixture/ui',managedBuild:true,runtime:{},outputDir:'/fixture/bin',entry:'index.html',appUrl:'https://go.bauertronix.com.br/app/',tunnel:{}})},
    './server':{PreviewServer:class{
      constructor(_shell,_entry,settings){options.push(settings);this.settings=settings;this.state={revision:null};}
      async start(storage,bind,port,advertised){started.push({bind,port,advertised});this.localOrigin=`http://${advertised}:54321`;this.setPublicOrigin(this.localOrigin);}
      setPublicOrigin(origin){this.appUrl=this.settings.appUrl||origin+'/app/';this.pairingUrl=this.settings.appUrl?this.appUrl+'#session='+encodeURIComponent(origin+'/s/'+'a'.repeat(48)+'/'):origin+'/s/'+'a'.repeat(48)+'/';}
      setState(){} async stop(){stopped++;}
    }},
    './tunnel':{ensureCloudflared:async()=>{ensured++;return 'cloudflared';},InternetTunnel:class{async start(){tunnels++;return 'https://fixture.trycloudflare.com';}async stop(){tunnels--;}}},
    './builder':{Builder:class{request(){builds++;}async stop(){}}}
  });
  extension.activate({subscriptions:[],extensionPath:'/extension',globalStorageUri:{fsPath:'/fixture/cache'},
    globalState:{get:(key,fallback)=>saved.has(key)?saved.get(key):fallback,update:async(key,value)=>saved.set(key,value)},
    workspaceState:{get:()=>undefined,update:async()=>{}}});
  await h.commands.get('lvglGo.dashboard')(); const webview=h.panels[0].webview;
  await webview.receive({action:'ready'});
  assert.equal(webview.messages.at(-1).localNetwork,mode==='remembered');
  if(mode!=='remembered') {await webview.receive({action:'local',checked:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(saved.get('localNetwork'),true);}
  await h.commands.get('lvglGo.start')();
  assert.equal(ensured,0);assert.equal(tunnels,0);
  if(mode==='no-address'||mode==='cancel') {
    assert.equal(started.length,0);assert.equal(builds,0);
    assert.equal(h.errors.length,mode==='no-address'?1:0);
    if(mode==='no-address')assert.match(h.errors[0],/No local IPv4 address/);
    assert.equal(webview.messages.at(-1).busy,false);return;
  }
  assert.equal(h.errors.length,0);assert.equal(builds,1);assert.equal(started.length,1);
  assert.equal(options[0].appUrl,undefined);
  const selected=mode==='multiple'?'10.0.0.30':'192.168.1.20';
  assert.deepEqual(started[0],{bind:selected,port:0,advertised:selected});
  assert(webview.messages.at(-1).url.startsWith(`http://${selected}:54321/s/`));
  assert.equal(webview.messages.at(-1).connected,true);
  assert(h.logs.some(line=>line.includes('Local network (HTTP)')));
  await webview.receive({action:'open'});await webview.receive({action:'copy'});
  assert.equal(opened[0],webview.messages.at(-1).url);assert.equal(copied[0],opened[0]);
  await webview.receive({action:'local',checked:false});assert.equal(saved.get('localNetwork'),true,'An active session must keep its connection mode');
  await h.commands.get('lvglGo.stop')();assert.equal(stopped,1);
  assert.equal(webview.messages.at(-1).localNetwork,true);
  if(mode==='switch') {
    await webview.receive({action:'local',checked:false});await new Promise(resolve=>setImmediate(resolve));
    await h.commands.get('lvglGo.start')();assert.equal(ensured,1);assert.equal(tunnels,1);
    assert.equal(options[1].appUrl,'https://go.bauertronix.com.br/app/');assert.equal(started[1].bind,'127.0.0.1');
    assert(webview.messages.at(-1).url.startsWith('https://go.bauertronix.com.br/app/'));
    await h.commands.get('lvglGo.stop')();assert.equal(tunnels,0);
  }
  assert.equal(picks,mode==='multiple'?1:0);
});
