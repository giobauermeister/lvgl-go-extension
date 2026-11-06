import * as vscode from 'vscode';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Dashboard } from './dashboard';
import { Builder } from './builder';
import { readConfig, shouldWatch, type Config } from './config';
import { PreviewServer } from './server';
import { exists, inspectProject, nearestProject, prepareManagedBuild } from './project';
import { ensureCloudflared, InternetTunnel } from './tunnel';
import { exportHtml } from './export';
import { localAddresses } from './network';

let session: { server: PreviewServer; builder: Builder; watcher: vscode.FileSystemWatcher; tunnel?: InternetTunnel; projectDir: string; config: Config } | undefined;
let dashboard: Dashboard;
let busy = false;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;


export function activate(context: vscode.ExtensionContext): void {
  let localNetwork = context.globalState.get<boolean>('localNetwork', false) === true;
  output = vscode.window.createOutputChannel('LVGL Go');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = '$(device-mobile) LVGL Go';
  status.command = 'lvglGo.dashboard';
  status.tooltip = 'Open the LVGL Go dashboard';
  status.show();
  context.subscriptions.push(output, status);
  dashboard = new Dashboard(async (name, checked) => {
    if (name === 'local') {
      if (!session && !busy && typeof checked === 'boolean') {
        localNetwork = checked;
        dashboard.update({ localNetwork });
        await context.globalState.update('localNetwork', localNetwork);
      } else dashboard.update({ localNetwork });
      return;
    }
    const commands: Record<string, string> = { start: 'lvglGo.start', stop: 'lvglGo.stop', build: 'lvglGo.build', screen: 'lvglGo.selectScreen', export: 'lvglGo.exportHtml' };
    if (commands[name]) return vscode.commands.executeCommand(commands[name]);
    if (name === 'output') output.show(true);
    if (name === 'copy' && session) return vscode.env.clipboard.writeText(session.server.pairingUrl);
    if (name === 'open' && session) return vscode.env.openExternal(vscode.Uri.parse(session.server.pairingUrl));
  });
  dashboard.update({ localNetwork });
  context.subscriptions.push(dashboard, vscode.window.registerWebviewViewProvider('lvglGo.dashboard', dashboard, { webviewOptions: { retainContextWhenHidden: true } }));
  const command = (name: string, fn: (...args: any[]) => unknown | Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: any[]) => {
    if (!vscode.workspace.isTrusted) { void vscode.window.showErrorMessage('Trust this workspace before running LVGL Go.'); return; }
    try { await fn(...args); } catch (error) { output.appendLine(String(error)); void vscode.window.showErrorMessage(`LVGL Go: ${String(error)}`); }
  }));
  command('lvglGo.start', async (uri?: vscode.Uri) => {
    if (session) { await showQr(); return; }
    if (busy) return;
    busy = true;
    dashboard.update({ busy: true, connected: false, canExport: false, status: 'Starting…', message: 'Preparing the project and connection.' });
    let server: PreviewServer | undefined;
    let builder: Builder | undefined;
    let watcher: vscode.FileSystemWatcher | undefined;
    let tunnel: InternetTunnel | undefined;
    try {
      const project = await chooseProject(uri);
      if (!project) { dashboard.update({ status: 'Stopped', message: 'No project selected.' }); return; }
      dashboard.update({ project });
      await dashboard.show();
      const projectKey = createHash('sha256').update(project).digest('hex').slice(0, 20);
      const storage = path.join(context.globalStorageUri.fsPath, 'projects', projectKey);
      const config = await readConfig(project, context.extensionPath, storage);
      if (!await selectStartingScreen(config, context)) { dashboard.update({ status: 'Stopped', message: 'No starting screen selected.' }); return; }
      await mkdir(storage, { recursive: true });
      output.show(true);
      output.appendLine(`Project: ${config.projectDir}`);
      output.appendLine(config.managedBuild ? 'Building exported C with the extension runtime.' : 'Using custom build commands from lvgl-go.json.');
      const shell = await readFile(path.join(context.extensionPath, 'media', 'preview.html'), 'utf8');
      let address = '127.0.0.1';
      if (localNetwork) {
        const addresses = localAddresses();
        if (!addresses.length) throw new Error('No local IPv4 address found. Connect to Wi-Fi or Ethernet, or uncheck Local network (HTTP) to use Internet mode.');
        const selected = addresses.length === 1 ? addresses[0] : await vscode.window.showQuickPick(
          addresses.map(item => ({ label: item.address, description: item.name, address: item.address })),
          { title: 'LVGL Go: Choose the local network', placeHolder: 'Choose the network shared with your phone or tablet.' });
        if (!selected) { dashboard.update({ status: 'Stopped', message: 'No local network selected.' }); return; }
        address = selected.address;
      }
      server = new PreviewServer(shell, config.entry, { appUrl: localNetwork ? undefined : config.appUrl });
      await server.start(path.join(storage, 'published'), address, 0, address);
      const activeServer = server;
      if (localNetwork) {
        output.appendLine(`Local network (HTTP): ${server.localOrigin}`);
        output.appendLine('Scan the QR code with your phone’s camera, or open the link on a device on the same local network.');
      } else {
        const executable = await ensureCloudflared(context.globalStorageUri.fsPath, config.tunnel.command, line => output.appendLine(line));
        tunnel = new InternetTunnel(line => output.appendLine(line), () => {
          activeServer.setState('error', 'Internet connection lost. Restart LVGL Go.');
          dashboard.update({ connected: false, status: 'Disconnected', message: 'Internet connection lost. Stop and restart the session.' });
        });
        output.appendLine('Connecting internet session…');
        dashboard.update({ status: 'Connecting…', message: 'Waiting for the preview address and public HTTPS connection.' });
        const publicOrigin = await tunnel.start(executable, server.localOrigin, storage);
        server.setPublicOrigin(publicOrigin, 'poll');
      }
      output.appendLine(`Mobile app: ${server.appUrl}`);
      builder = new Builder(config, line => output.appendLine(line), (state, message) => {
        activeServer.setState(state, message);
        dashboard.update({ status: state === 'building' ? 'Building…' : state === 'error' ? 'Build failed' : state === 'ready' ? 'Ready' : 'Waiting for build', canExport: !!activeServer.state.revision, message: message ?? '' });
        status.text = state === 'building' ? '$(sync~spin) LVGL Go' : state === 'error' ? '$(error) LVGL Go' : '$(device-mobile) LVGL Go';
      }, () => activeServer.publish(config.outputDir), () => prepareManagedBuild(config));
      watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(config.projectDir), '**/*'));
      const activeBuilder = builder;
      const changed = (uri: vscode.Uri) => {
        if (!config.watch) return;
        const outputRelative = path.relative(config.outputDir, uri.fsPath);
        if (outputRelative === '' || (!outputRelative.startsWith('..') && !path.isAbsolute(outputRelative))) return;
        if (shouldWatch(path.relative(config.projectDir, uri.fsPath))) activeBuilder.request();
      };
      watcher.onDidChange(changed);
      watcher.onDidCreate(changed);
      watcher.onDidDelete(changed);
      session = { server, builder, watcher, tunnel, projectDir: config.projectDir, config };
      dashboard.update({ active: true, connected: true, url: server.pairingUrl, status: 'Waiting for build' });
      status.command = 'lvglGo.dashboard';
      status.tooltip = 'Show the pairing QR code';
      output.appendLine('Session started. The QR code contains a private pairing URL.');
      output.appendLine(`Pair device (keep this link private): ${server.pairingUrl}`);
      output.show(true);
      builder.request(true);
    } catch (error) {
      watcher?.dispose();
      await builder?.stop();
      await tunnel?.stop();
      await server?.stop();
      session = undefined;
      dashboard.update({ active: false, connected: false, url: '', status: 'Start failed', message: String(error) });
      throw error;
    } finally { busy = false; dashboard.update({ busy: false }); }
  });
  command('lvglGo.dashboard', () => dashboard.show());
  command('lvglGo.stop', stop);
  command('lvglGo.showQr', showQr);
  command('lvglGo.build', () => requireSession().builder.request(true));
  command('lvglGo.exportHtml', async () => {
    const active = requireSession(), snapshot = active.server.publishedSnapshot();
    if (!snapshot) throw new Error('Wait for the first successful WASM build before exporting.');
    const name = path.basename(active.projectDir).replace(/[^A-Za-z0-9_.-]/g, '_');
    const destination = await vscode.window.showSaveDialog({ title: 'Export LVGL Go preview', saveLabel: 'Export HTML',
      defaultUri: vscode.Uri.file(path.join(active.projectDir, name + '-preview.html')), filters: { HTML: ['html'] } });
    if (!destination) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LVGL Go: Exporting HTML preview…' }, async () => {
      const html = await exportHtml(snapshot, context.extensionPath, path.basename(active.projectDir));
      await vscode.workspace.fs.writeFile(destination, html);
    });
    output.appendLine('Standalone HTML exported: ' + destination.fsPath);
    void vscode.window.showInformationMessage('LVGL Go: HTML preview exported. Share the file; no running session is needed.');
  });
  command('lvglGo.selectScreen', async () => {
    const active = requireSession();
    if (await selectStartingScreen(active.config, context, true)) active.builder.request(true);
  });
}

async function selectStartingScreen(config: Config, context: vscode.ExtensionContext, force = false): Promise<boolean> {
  if (!config.managedBuild) { dashboard.update({ canChooseScreen: false }); return true; }
  const project = await inspectProject(config.projectDir);
  const canChoose = !project.initialScreen && !config.runtime.initialScreen && project.screens.length > 1;
  dashboard.update({ canChooseScreen: canChoose });
  if (!canChoose && !force) return true;
  if (!force && config.runtime.startScreen) return true;
  if (!project.screens.length) return true;
  const key = 'startScreen:' + config.projectDir;
  const saved = context.workspaceState.get<string>(key);
  const selected = !force && saved && project.screens.includes(saved) ? saved
    : (await vscode.window.showQuickPick(project.screens.map(name => ({
      label: name.replace(/_create$/, ''), description: name + '()', picked: name === saved, name
    })), { title: 'LVGL Go: Choose the starting screen', placeHolder: 'Remembered for this project. Used when its initialization leaves the display empty.' }))?.name;
  if (!selected) return false;
  config.runtime.startScreen = selected;
  await context.workspaceState.update(key, selected);
  output.appendLine('Starting screen: ' + selected);
  return true;
}

async function chooseProject(uri?: vscode.Uri): Promise<string | undefined> {
  const active = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    const project = await nearestProject(active.fsPath);
    if (project) return project;
  }
  const roots = vscode.workspace.workspaceFolders ?? [];
  const direct = (await Promise.all(roots.map(async folder => await exists(path.join(folder.uri.fsPath, 'project.xml')) ? folder.uri.fsPath : undefined))).filter((p): p is string => !!p);
  if (direct.length === 1) return direct[0];
  const found = direct.length ? direct : (await vscode.workspace.findFiles('**/project.xml', '**/{node_modules,.git,.lvgl-go,build,build-*,preview-bin,preview-build,_deps}/**', 30)).map(file => path.dirname(file.fsPath));
  const projects = [...new Set(found)];
  if (projects.length === 1) return projects[0];
  if (projects.length > 1) return (await vscode.window.showQuickPick(projects.map(directory => ({ label: path.basename(directory), description: directory })), { title: 'LVGL Go: Choose the LVGL Pro project to preview' }))?.description;
  throw new Error('Open your LVGL Pro project folder (the folder containing project.xml) in VS Code, or run Start Session from its project.xml context menu.');
}


function requireSession() {
  if (!session) throw new Error('Run LVGL Go: Start Session first.');
  return session;
}

async function showQr(): Promise<void> {
  requireSession();
  await dashboard.show();
}


async function stop(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const previous = session;
    session = undefined;
    previous?.watcher.dispose();
    dashboard.update({ active: false, connected: false, busy: true, url: '', canChooseScreen: false, canExport: false, status: 'Stopping…' });
    await previous?.builder.stop();
    await previous?.tunnel?.stop();
    await previous?.server.stop();
    status.text = '$(device-mobile) LVGL Go';
    status.command = 'lvglGo.dashboard';
    status.tooltip = 'Open the LVGL Go dashboard';
  } finally { busy = false; dashboard.update({ busy: false, status: 'Stopped', message: 'Start a session to preview the current LVGL Pro project.' }); }
}

export async function deactivate(): Promise<void> { await stop(); }
