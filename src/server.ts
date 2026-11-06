import http, { ServerResponse } from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, copyFile, stat, realpath, rm, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { isPrivateFile } from './assets';

export interface SessionState {
  protocol: 1;
  status: 'idle' | 'building' | 'ready' | 'error';
  revision: string | null;
  entry: string;
  message?: string;
  transport?: 'sse' | 'poll';
  /** Decoded byte sizes of WASM, preload packages and available hardware frames. */
  downloadBytes?: Record<string, number>;
  /** Public display/frame choices needed to plan startup before WASM runs. */
  hardware?: { initial: number; targets: { name: string; image?: string; hidden: boolean }[] };
}

interface ServerOptions {
  mediaDir?: string;
  tls?: { cert: Buffer; key: Buffer };
  appUrl?: string;
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};

export class PreviewServer {
  private token = randomBytes(24).toString('hex');
  private basePath = `/s/${this.token}/`;
  private clients = new Set<ServerResponse>();
  private snapshots = new Map<string, string>();
  private server: http.Server;
  private heartbeat?: NodeJS.Timeout;
  private storage = '';
  state: SessionState;
  url = '';
  appUrl = '';
  pairingUrl = '';
  localOrigin = '';

  constructor(private shell: string, entry: string, private options: ServerOptions = {}) {
    if (options.appUrl) {
      const url = new URL(options.appUrl);
      if (url.protocol !== 'https:' || url.pathname !== '/app/' || url.search || url.hash || url.username || url.password) throw new Error('Invalid hosted app URL.');
    }
    this.state = { protocol: 1, status: 'idle', revision: null, entry };
    const listener = (req: http.IncomingMessage, res: ServerResponse) => {
      void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(404); res.end(); });
    };
    this.server = options.tls ? https.createServer(options.tls, listener) : http.createServer(listener);
  }

  async start(storage: string, bind: string, port: number, advertisedHost: string): Promise<string> {
    this.storage = path.join(storage, `session-${this.token}`);
    await mkdir(this.storage, { recursive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(port, bind, () => { this.server.off('error', reject); resolve(); });
      });
    } catch (error) { await rm(this.storage, { recursive: true, force: true }); throw error; }
    // Runtime errors after listen should not crash the extension host.
    this.server.on('error', () => this.setState('error', 'Preview server error. Restart the session.'));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const host = advertisedHost.includes(':') ? `[${advertisedHost}]` : advertisedHost;
    this.localOrigin = `${this.options.tls ? 'https' : 'http'}://${host}:${address.port}`;
    this.setPublicOrigin(this.localOrigin);
    this.heartbeat = setInterval(() => { for (const client of this.clients) client.write(': heartbeat\n\n'); }, 15000);
    this.heartbeat.unref();
    return this.url;
  }

  setPublicOrigin(value: string, transport: 'sse' | 'poll' = 'sse'): void {
    const origin = new URL(value);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid public preview origin.');
    this.url = `${origin.origin}${this.basePath}`;
    this.appUrl = this.options.appUrl ?? `${origin.origin}/app/`;
    this.pairingUrl = !this.options.appUrl && origin.protocol === 'http:' ? this.url
      : `${this.appUrl}#session=${encodeURIComponent(this.options.appUrl ? this.url : this.basePath)}`;
    this.state = { ...this.state, transport };
  }

  setState(status: SessionState['status'], message?: string): void {
    this.state = { ...this.state, status, message };
    this.broadcast();
  }

  private broadcast(): void {
    for (const client of this.clients) client.write(`data: ${JSON.stringify(this.state)}\n\n`);
  }

  publishedSnapshot(): { directory: string; entry: string } | undefined {
    const directory = this.state.revision && this.snapshots.get(this.state.revision);
    return directory ? { directory, entry: this.state.entry } : undefined;
  }

  async publish(outputDir: string): Promise<void> {
    const revision = randomBytes(8).toString('hex');
    const target = path.join(this.storage, revision);
    const downloadBytes: Record<string, number> = {};
    let hardware: SessionState['hardware'];
    const output = await realpath(outputDir);
    const relation = path.relative(output, this.storage);
    if (relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation))) throw new Error('outputDir must not contain the session storage.');
    try {
      await this.copyBundle(output, target, downloadBytes);
      const entry = path.join(target, this.state.entry);
      if (!(await stat(entry)).isFile()) throw new Error('No HTML entry was produced.');
      // Read only the normalized bundle metadata; no project files or paths enter
      // the session manifest. Older/custom bundles can omit this information.
      try {
        const folder = path.posix.join(path.posix.dirname(this.state.entry), 'lvgl-go-overlay');
        const metadata = JSON.parse(await readFile(path.join(target, folder, 'manifest.json'), 'utf8'));
        if (metadata.version === 1 && Array.isArray(metadata.targets) && metadata.targets.every((item: any) => typeof item.name === 'string'
          && (!item.overlay || /^frame-\d+\.(png|jpe?g|webp|gif|svg)$/.test(item.overlay.image)))) {
          hardware = { initial: Number.isInteger(metadata.initial) && metadata.initial >= -1 && metadata.initial < metadata.targets.length ? metadata.initial : 0,
            targets: metadata.targets.map((item: any) => {
              const image = item.overlay && path.posix.join(folder, item.overlay.image);
              return { name: item.name, image: image && Object.hasOwn(downloadBytes, image) ? image : undefined, hidden: item.overlay?.hidden === true };
            }) };
        }
      } catch { /* No hardware metadata: preserve the custom/legacy loader. */ }
    } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
    // Switch only after the entire bundle exists; failed builds keep the previous revision.
    this.snapshots.set(revision, target);
    this.state = { ...this.state, revision, downloadBytes, hardware };
    // Keep snapshots for this session so older clients can finish fetching all assets.
    this.broadcast();
  }

  private async copyBundle(source: string, target: string, downloadBytes: Record<string, number>, relative = ''): Promise<void> {
    await mkdir(target, { recursive: true });
    for (const item of await readdir(source, { withFileTypes: true })) {
      if (isPrivateFile(item.name)) continue;
      const src = path.join(source, item.name), dest = path.join(target, item.name);
      const name = path.posix.join(relative, item.name);
      if (item.isDirectory()) await this.copyBundle(src, dest, downloadBytes, name);
      else if (item.isFile() && mime[path.extname(item.name).toLowerCase()]) {
        await copyFile(src, dest);
        if (/\.(wasm|data)$/i.test(name) || /(?:^|\/)lvgl-go-overlay\/frame-\d+\.(png|jpe?g|webp|gif|svg)$/i.test(name)) downloadBytes[name] = (await stat(dest)).size;
      }
      // Symlinks, C sources, XML, maps and arbitrary workspace files are never published.
    }
  }

  private async handle(req: http.IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    // Parse the raw path so URL normalisation cannot hide traversal attempts.
    const raw = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (raw === '/app/' || raw === '/app/index.html') {
      this.appHeaders(res);
      res.setHeader('Content-Type', mime['.html']);
      res.end(req.method === 'HEAD' ? undefined : this.shell);
      return;
    }
    const assets: Record<string, string> = {
      '/app/app.js': 'app.js', '/app/styles.css': 'styles.css', '/app/player.js': 'player.js', '/app/console.js': 'console.js', '/app/memory.js': 'memory.js', '/app/view.js': 'view.js',
      '/app/session.js': 'session.js', '/app/sw.js': 'sw.js',
      '/app/updates.js': 'updates.js',
      '/app/manifest.webmanifest': 'manifest.webmanifest',
      '/app/icon-180.png': 'icon-180.png', '/app/icon-192.png': 'icon-192.png',
      '/app/icon-maskable-512.png': 'icon-maskable-512.png', '/app/icon-512.png': 'icon-512.png', '/app/icon.svg': 'icon.svg'
    };
    if (/^\/app\/startup-\d{3,4}x\d{3,4}\.png$/.test(raw)) assets[raw] = raw.slice('/app/'.length);
    if (raw === '/app/qr.js' || Object.hasOwn(assets, raw)) {
      const file = raw === '/app/qr.js' ? require.resolve('jsqr') : path.join(this.options.mediaDir ?? path.join(__dirname, '..', 'media'), assets[raw]);
      const info = await stat(file);
      res.setHeader('Content-Type', raw.endsWith('.webmanifest') ? 'application/manifest+json' : mime[path.extname(file)] ?? 'application/octet-stream');
      res.setHeader('Content-Length', info.size);
      if (req.method === 'HEAD') res.end();
      else await pipeline(createReadStream(file), res);
      return;
    }
    if (!raw.startsWith(this.basePath)) { res.writeHead(404); res.end(); return; }
    if (this.options.appUrl) {
      const appOrigin = new URL(this.options.appUrl).origin;
      const previewOrigin = new URL(this.url).origin;
      const requestOrigin = req.headers.origin;
      if (requestOrigin && requestOrigin !== appOrigin && requestOrigin !== previewOrigin) { res.writeHead(403); res.end(); return; }
      res.setHeader('Access-Control-Allow-Origin', appOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${appOrigin}`);
    }
    const route = raw.slice(this.basePath.length);
    if (route.split('/').some(p => p === '.' || p === '..') || route.includes('\\') || route.includes('\0')) { res.writeHead(404); res.end(); return; }
    if (route === '' || route === 'index.html') {
      if (!this.options.appUrl && !this.options.tls) {
        // A direct session address survives camera/link handlers that drop fragments.
        this.appHeaders(res);
        res.setHeader('Content-Type', mime['.html']);
        res.end(req.method === 'HEAD' ? undefined : this.shell);
      } else { res.writeHead(302, { Location: this.pairingUrl }); res.end(); }
      return;
    }
    if (route === 'manifest.json') { res.setHeader('Content-Type', mime['.json']); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(this.state)); return; }
    if (route === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(this.state)}\n\n`);
      this.clients.add(res);
      res.once('close', () => this.clients.delete(res));
      return;
    }
    const [prefix, revision, ...segments] = route.split('/');
    const root = prefix === 'bundle' && this.snapshots.get(revision);
    if (!root || !segments.length) { res.writeHead(404); res.end(); return; }
    const file = path.join(root, ...segments);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(404); res.end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { res.writeHead(404); res.end(); return; }
    const extension = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', mime[extension] ?? 'application/octet-stream');
    const compressible = info.size >= 1024 && ['.wasm', '.js', '.data', '.bin', '.html', '.css', '.json', '.svg'].includes(extension);
    const encodings = (req.headers['accept-encoding'] ?? '').toLowerCase().split(',').map(value => {
      const [name, ...parameters] = value.trim().split(';');
      const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
      return { name, quality: quality ? Number(quality.trim().slice(2)) : 1 };
    });
    const gzip = encodings.find(value => value.name === 'gzip') ?? encodings.find(value => value.name === '*');
    if (compressible) res.setHeader('Vary', [res.getHeader('Vary'), 'Accept-Encoding'].filter(Boolean).join(', '));
    const compressed = compressible && gzip && gzip.quality > 0;
    if (compressed) res.setHeader('Content-Encoding', 'gzip');
    else res.setHeader('Content-Length', info.size);
    if (req.method === 'HEAD') res.end();
    else if (compressed) await pipeline(createReadStream(file), createGzip(), res);
    else await pipeline(createReadStream(file), res);
  }

  private appHeaders(res: ServerResponse): void {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; media-src 'self' blob:; frame-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
    await new Promise<void>(resolve => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    if (this.storage) await rm(this.storage, { recursive: true, force: true });
  }
}
