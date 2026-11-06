import { spawn, ChildProcess, execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { waitForTunnelReady } from './tunnel-readiness';

const VERSION = '2026.10.1';
const RELEASES: Record<string, [string, string]> = {
  'linux-x64': ['cloudflared-linux-amd64', '3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586'],
  'linux-arm64': ['cloudflared-linux-arm64', '2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46'],
  'darwin-x64': ['cloudflared-darwin-amd64.tgz', '3b0dbaf378337e9d7fb6cd235a76d1d6a7dee434c2d8edf9281164fb6a3837ab'],
  'darwin-arm64': ['cloudflared-darwin-arm64.tgz', '647615df99d49cd179ea5e13ef760b9bbfb33630f6ae62f87e33dfadda60adcc'],
  'win32-x64': ['cloudflared-windows-amd64.exe', '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6']
};

export async function ensureCloudflared(storage: string, configured: string | undefined, log: (line: string) => void): Promise<string> {
  if (configured) return configured;
  const run = promisify(execFile);
  if (await run('cloudflared', ['--version'], { timeout: 5000, windowsHide: true }).then(() => true, () => false)) return 'cloudflared';
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error('Install cloudflared and set tunnel.command for this platform.');
  const directory = path.join(storage, 'tools', `cloudflared-${VERSION}`);
  const executable = path.join(directory, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (await access(executable).then(() => true, () => false)) return executable;
  await mkdir(directory, { recursive: true });
  log(`Downloading official cloudflared ${VERSION} for ${process.platform}/${process.arch}…`);
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${release[0]}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`cloudflared download failed (${response.status}). Install it separately or set tunnel.command.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== release[1]) throw new Error('cloudflared checksum verification failed.');
  const temporary = executable + '.download';
  await writeFile(temporary, bytes, { mode: 0o700 });
  try {
    if (release[0].endsWith('.tgz')) {
      await run('tar', ['-xzf', temporary, '-C', directory, 'cloudflared'], { timeout: 10000, windowsHide: true });
    } else await rename(temporary, executable);
    if (process.platform !== 'win32') await chmod(executable, 0o700);
  } finally { await rm(temporary, { force: true }); }
  log('cloudflared download verified with its pinned SHA-256 digest.');
  return executable;
}

export class InternetTunnel {
  private child?: ChildProcess;
  private closed?: Promise<void>;
  private stopping = false;
  private cancelStart?: () => void;

  constructor(private log: (line: string) => void, private disconnected: () => void = () => {}, private launch: typeof spawn = spawn,
    private waitUntilReady = waitForTunnelReady) {}

  async start(executable: string, localOrigin: string, storage: string): Promise<string> {
    if (this.child) throw new Error('Tunnel already started.');
    const origin = new URL(localOrigin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('The tunnel origin must be a loopback HTTP server.');
    await mkdir(storage, { recursive: true });
    const config = path.join(storage, 'quick-tunnel.yaml');
    await writeFile(config, '{}\n');
    this.stopping = false;
    return new Promise((resolve, reject) => {
      let url: string | undefined, registered = false, settled = false, checking = false, ready = false;
      const started = Date.now(), controller = new AbortController();
      this.log('Starting internet tunnel…');
      const child = this.launch(executable, ['tunnel', '--config', config, '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:0', '--url', origin.origin], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      this.closed = new Promise<void>(done => child.once('close', () => done()));
      const timer = setTimeout(() => { fail(new Error('The internet tunnel did not connect within 45 seconds. Check internet/firewall access and retry.')); }, 45000);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.cancelStart = undefined;
        controller.abort(error); child.kill(); reject(error);
      };
      this.cancelStart = () => fail(new Error('Internet session startup canceled.'));
      const checkReady = () => {
        if (!url || !registered || settled || checking) return;
        checking = true; clearTimeout(timer);
        const publicOrigin = url;
        this.log(`Internet tunnel connected (${Math.round((Date.now() - started) / 1000)}s). Preparing the public preview address…`);
        void this.waitUntilReady(publicOrigin, this.log, controller.signal).then(() => {
          if (settled) return;
          settled = ready = true; this.cancelStart = undefined;
          this.log(`Internet session ready (${Math.round((Date.now() - started) / 1000)}s total).`);
          resolve(publicOrigin);
        }).catch(fail);
      };
      const capture = () => {
        let buffer = '';
        return (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/); buffer = lines.pop()!;
          for (const line of lines) {
            const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
            if (match) url = match[0];
            if (line.includes('Registered tunnel connection')) registered = true;
            // Avoid logging environment/config paths emitted by the third-party CLI.
            if (/ERR |WRN /.test(line)) this.log('Tunnel: ' + line);
            checkReady();
          }
        };
      };
      child.stdout?.on('data', capture()); child.stderr?.on('data', capture());
      child.once('error', error => fail(new Error(`Could not start cloudflared: ${error.message}`)));
      child.once('close', code => {
        this.child = undefined;
        if (!settled) fail(new Error(`cloudflared exited before the public preview was ready (${code}).`));
        else if (ready && !this.stopping) this.disconnected();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    this.cancelStart?.();
    child.kill();
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await this.closed; } finally { clearTimeout(force); }
  }
}
