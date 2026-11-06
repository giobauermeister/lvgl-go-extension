import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as QRCode from 'qrcode';
import { readFileSync } from 'node:fs';
import path from 'node:path';

interface DashboardState {
  project: string;
  status: string;
  message: string;
  active: boolean;
  connected: boolean;
  busy: boolean;
  url: string;
  qr: string;
  canChooseScreen: boolean;
  canExport: boolean;
  localNetwork: boolean;
}

export class Dashboard implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private generation = 0;
  private state: DashboardState = { project: '', status: 'Stopped', message: 'Open an LVGL Pro project and start a session.', active: false, connected: false, busy: false, url: '', qr: '', canChooseScreen: false, canExport: false, localNetwork: false };

  constructor(private action: (name: string, checked?: boolean) => Promise<unknown>) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.title = 'LVGL Go';
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
    view.onDidChangeVisibility(() => { if (view.visible) this.send(); });
    this.initialize(view.webview);
  }

  private initialize(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [] };
    webview.onDidReceiveMessage(message => {
      if (message?.action === 'ready') { this.send(); return; }
      if (message?.action === 'local' && typeof message.checked === 'boolean') {
        void this.action('local', message.checked).catch(error => { void vscode.window.showErrorMessage(`LVGL Go: ${String(error)}`); });
        return;
      }
      if (typeof message?.action === 'string' && ['start', 'stop', 'build', 'copy', 'open', 'output', 'screen', 'export'].includes(message.action)) {
        void this.action(message.action).catch(error => { void vscode.window.showErrorMessage(`LVGL Go: ${String(error)}`); });
      }
    });
    webview.html = this.html();
  }

  async show(): Promise<void> {
    // Reuse the Activity Bar view when the host has already resolved it.
    // Start/Stop from that view must not open a second editor dashboard.
    if (this.view) {
      this.view.show(true);
      this.send();
      return;
    }
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('lvglGo.dashboardPanel', 'LVGL Go', vscode.ViewColumn.Beside,
        { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
      this.panel = panel;
      panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
      this.initialize(panel.webview);
    }
    this.panel.reveal();
  }

  dispose(): void { this.panel?.dispose(); }

  update(patch: Partial<DashboardState>): void {
    const oldUrl = this.state.url;
    this.state = { ...this.state, ...patch };
    if (oldUrl !== this.state.url) {
      const generation = ++this.generation;
      this.state.qr = '';
      if (this.state.url) void QRCode.toDataURL(this.state.url, { width: 360, margin: 3, errorCorrectionLevel: 'M' }).then(qr => {
        if (generation === this.generation) { this.state.qr = qr; this.send(); }
      }, () => {
        if (generation === this.generation) { this.state.message = 'QR generation failed. Use Copy Link to pair your device.'; this.send(); }
      });
    }
    this.send();
  }

  private send(): void {
    if (this.view) void this.view.webview.postMessage(this.state);
    if (this.panel) void this.panel.webview.postMessage(this.state);
  }

  private html(): string {
    const nonce = randomBytes(16).toString('hex');
    const logo = readFileSync(path.join(__dirname, '..', 'media', 'icon.svg'), 'utf8');
    const icon = (name: string) => {
      const shapes: Record<string, string> = {
        play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
        stop: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>',
        terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
        folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
        copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H4v13h4"/>',
        external: '<path d="M14 3h7v7m0-7L10 14M10 5H4v15h15v-6"/>',
        build: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
        download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
        bolt: '<path d="m13 3-9 11h7l-1 7 10-12h-7Z"/>'
      };
      return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]}</svg>`;
    };
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
      <style nonce="${nonce}">
      :root{
        --page:var(--vscode-sideBar-background,var(--vscode-editor-background,#151515));
        --ink:var(--vscode-foreground,#ddd);
        --muted:color-mix(in srgb,var(--ink) 80%,var(--page));
        --card:color-mix(in srgb,var(--ink) 8%,var(--page));
        --control:color-mix(in srgb,var(--ink) 14%,var(--page));
        --control-hover:color-mix(in srgb,var(--ink) 20%,var(--page));
        --border:var(--vscode-widget-border,rgba(128,128,128,.24));
      }
      *{box-sizing:border-box}
      body{margin:0;padding:22px 18px;color:var(--ink);background:var(--page);font-family:var(--vscode-font-family,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);font-size:14px;line-height:1.55}
      main{width:100%;max-width:420px;margin:auto}
      button{font:inherit;font-weight:500;color:var(--ink);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:8px 12px;border:1px solid var(--border);border-radius:7px;background:var(--control);transition:background .15s,opacity .15s}
      button:hover{background:var(--control-hover)}button:disabled{opacity:.55;cursor:default}
      button:focus-visible{outline:2px solid var(--vscode-focusBorder,#329bbc);outline-offset:3px}
      .icon{width:16px;height:16px;flex:none}h1,h2,p{margin:0}
      h1{font-size:17px;font-weight:650;line-height:1.4}
      h2,.eyebrow{font-size:12px;letter-spacing:.5px;text-transform:uppercase;font-weight:600;color:var(--muted)}
      .service{display:flex;align-items:center;gap:12px;margin:0 2px 18px}
      .brand-mark{width:40px;height:40px;flex:none}.brand-mark svg{display:block;width:100%;height:100%}
      .service-info{flex:1;min-width:0}.connection{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--muted);margin-top:2px}
      .led{width:9px;height:9px;flex:none;border-radius:50%;background:#777;box-shadow:0 0 0 3px rgba(128,128,128,.08)}
      .led.on{background:#59d48b;box-shadow:0 0 0 3px rgba(89,212,139,.1),0 0 10px rgba(89,212,139,.25)}
      .led.pending{background:#dbb85d;animation:breathe 1.4s ease-in-out infinite}.led.error{background:var(--vscode-errorForeground,#f48771)}
      .output{width:32px;min-height:32px;padding:7px;color:var(--muted)}
      .session-button{width:100%;font-weight:600;min-height:38px}
      .network-option{display:flex;width:100%;align-items:center;gap:8px;margin:0 0 4px;padding:4px 8px;border-radius:5px;font-size:13px;cursor:pointer}.network-option:hover:has(input:not(:disabled)){background:var(--control)}.network-option input{margin:0;color-scheme:dark;accent-color:var(--vscode-button-background,#247e9b)}
      .network-option input:focus{outline:none!important;box-shadow:none!important}
      body.vscode-light .network-option input{color-scheme:light}
      .network-note{font-size:12px;color:var(--muted);margin:0 0 14px;line-height:1.5}
      .primary{background:var(--vscode-button-background,#247e9b);color:var(--vscode-button-foreground,#fff);border-color:transparent}
      .primary:hover{background:var(--vscode-button-hoverBackground,#2c8dab)}
      .stop{background:var(--control)}.stop .icon{width:14px;height:14px}
      .project-card{display:flex;gap:12px;align-items:center;padding:13px 14px;margin-top:16px;border-radius:8px;background:var(--card);border:1px solid var(--border)}
      .project-card>.icon{color:var(--muted);width:19px;height:19px}.project-info{flex:1;min-width:0}
      .project-name{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .project-path{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}
      .notice{font-size:13px;color:var(--muted);line-height:1.6;margin-top:12px;overflow-wrap:anywhere}
      .section{margin-top:24px;padding-top:18px;border-top:1px solid var(--border)}
      .section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
      .qr-card{display:grid;place-items:center;background:#fff;border-radius:10px;padding:12px;width:min(100%,260px);margin:4px auto 16px}
      .qr-card img{display:block;width:100%;height:auto;aspect-ratio:1}.qr-pending{padding:24px;text-align:center;font-size:13px;color:#555}
      .actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .caption{font-size:13px;line-height:1.6;color:var(--muted);margin-top:10px}.pair-hint{text-align:center;width:100%;margin:12px 0 0}
      .build-status{font-size:12px;line-height:22px;padding:1px 8px;border:1px solid var(--border);border-radius:5px;color:var(--muted);white-space:nowrap}
      .build-status.ready{color:var(--vscode-testing-iconPassed,#59d48b)}.build-status.error{color:var(--vscode-errorForeground,#f48771)}
      .build-button{width:100%}
      .screen-button{width:100%;margin-top:8px;font-size:13px}
      .auto-note{display:flex;align-items:flex-start;gap:7px;font-size:13px;color:var(--muted);margin-top:12px}
      .auto-note .icon{width:14px;height:14px;margin-top:3px}
      .footer{margin-top:24px;padding-top:14px;border-top:1px solid var(--border);font-size:12px;color:var(--muted)}
      [hidden]{display:none!important}@keyframes breathe{50%{opacity:.45}}
      @media(prefers-reduced-motion:reduce){.led.pending{animation:none}button{transition:none}}
      @media(max-width:260px){body{padding:18px 12px}.actions{grid-template-columns:1fr}}
      </style></head><body><main>
      <header class="service"><div class="brand-mark" aria-hidden="true">${logo}</div><div class="service-info"><h1>LVGL Go</h1><p class="connection" role="status"><span id="connection-led" class="led" aria-hidden="true"></span><span id="connection-label">Not running</span></p></div><button id="output" class="output" title="Show Output" aria-label="Show Output">${icon('terminal')}</button></header>
      <label class="network-option"><input id="local" type="checkbox" aria-describedby="network-note">Local network (HTTP)</label><p id="network-note" class="network-note">Internet preview · works across networks.</p>
      <div><button id="start" class="session-button primary">${icon('play')}<span>Start Session</span></button><button id="stop" class="session-button stop" hidden>${icon('stop')}<span>Stop Session</span></button></div>
      <div class="project-card">${icon('folder')}<div class="project-info"><p class="eyebrow">Project</p><p id="project" class="project-name">Current LVGL Pro project</p><p id="project-path" class="project-path" hidden></p></div></div>
      <p id="message" class="notice" hidden></p>
      <section id="pair" class="section" hidden><div class="section-heading"><h2>Preview on your device</h2></div><div class="qr-card"><img id="qr" hidden alt="Scan to open this preview session"><p id="qr-pending" class="qr-pending">Preparing QR code…</p></div><div class="actions"><button id="copy">${icon('copy')}<span>Copy Link</span></button><button id="open">${icon('external')}<span>Open Preview</span></button></div><p id="pair-hint" class="caption pair-hint">Open LVGL Go on your device, then scan this code.</p></section>
      <section class="section"><div class="section-heading"><h2>Build</h2><span id="status" class="build-status" role="status">Stopped</span></div><button id="build" class="build-button">${icon('build')}<span>Build C</span></button><p class="auto-note">${icon('bolt')}<span>Changes saved in LVGL Pro rebuild automatically.</span></p></section>
      <button id="screen" class="screen-button" hidden>Choose Starting Screen</button>
      <section class="section"><div class="section-heading"><h2>Share</h2></div><button id="export" class="build-button" disabled>${icon('download')}<span>Export HTML</span></button><p class="caption">Save the latest successful build as one HTML file with the UI, assets and preview controls. Recipients can open it without a running session.</p></section>
      <p class="footer">Keep this session running for live previews.</p>
      <script nonce="${nonce}">
      const vscode = acquireVsCodeApi(), $ = id => document.getElementById(id);
      for(const id of ['start','stop','build','copy','open','output','screen','export']) $(id).onclick = () => vscode.postMessage({action:id});
      $('local').onchange = () => vscode.postMessage({action:'local',checked:$('local').checked});
      addEventListener('message', ({data:s}) => {
        $('local').checked=s.localNetwork===true; $('local').disabled=s.busy || s.active;
        $('network-note').textContent=s.localNetwork ? 'Same network · opens directly on your computer.' : 'Internet preview · works across networks.';
        $('pair-hint').textContent=s.localNetwork ? 'Scan with your phone’s camera. Keep both devices on the same local network.' : 'Open LVGL Go on your device, then scan this code.';
        const name=s.project ? s.project.replaceAll(String.fromCharCode(92),'/').split('/').filter(Boolean).pop() : '';
        $('project').textContent=name || 'Current LVGL Pro project'; $('project').title=s.project;
        $('project-path').textContent=s.project; $('project-path').title=s.project; $('project-path').hidden=!s.project;
        $('status').textContent=s.status; $('status').className='build-status'+(s.status==='Ready' ? ' ready' : /failed/i.test(s.status) ? ' error' : '');
        $('message').textContent=s.message; $('message').hidden=!s.message;
        $('connection-label').textContent=s.connected ? 'Connected' : s.active ? 'Disconnected' : s.busy ? s.status : 'Not running';
        $('connection-led').className='led'+(s.connected ? ' on' : s.busy ? ' pending' : /failed|disconnected/i.test(s.status) ? ' error' : '');
        $('pair').hidden=!s.active;
        $('qr').hidden=!s.qr; $('qr-pending').hidden=!!s.qr; if(s.qr) $('qr').src=s.qr; else $('qr').removeAttribute('src');
        $('screen').hidden=!s.active || !s.canChooseScreen; $('screen').disabled=s.busy || !s.active;
        $('start').hidden=s.active; $('stop').hidden=!s.active;
        $('start').disabled=s.busy || s.active; $('stop').disabled=s.busy || !s.active;
        for(const id of ['build','copy','open']) $(id).disabled=s.busy || !s.active;
        $('export').disabled=s.busy || !s.active || !s.canExport;
      }); vscode.postMessage({action:'ready'});
      </script></main></body></html>`;
  }
}
