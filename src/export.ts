import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { isPrivateFile } from './assets';
const compress = promisify(gzip);

const types: Record<string, string> = {
  '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};

/** Package an immutable published build, never the workspace or a pairing URL. */
export async function exportHtml(snapshot: { directory: string; entry: string }, extensionDir: string, project: string): Promise<Buffer> {
  const files: Record<string, { type: string; data: string }> = {};
  const visit = async (folder: string, prefix = ''): Promise<void> => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const name = path.posix.join(prefix, item.name);
      if (isPrivateFile(name)) continue;
      if (item.isDirectory()) await visit(path.join(folder, item.name), name);
      else if (item.isFile() && types[path.extname(item.name).toLowerCase()]) files[name] = {
        type: types[path.extname(item.name).toLowerCase()], data: (await readFile(path.join(folder, item.name))).toString('base64')
      };
    }
  };
  await visit(snapshot.directory);
  if (snapshot.entry.startsWith('/') || snapshot.entry.includes('\\') || snapshot.entry.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid preview entry.');
  const entry = await readFile(path.join(snapshot.directory, snapshot.entry), 'utf8');
  const folder = path.posix.dirname(snapshot.entry);
  const scripts = [...entry.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))[^>]*>/gi)]
    .map(match => path.posix.join(folder, match[1] || match[2] || match[3]))
    .filter(name => files[name] && !/^lvgl-go-/.test(path.posix.basename(name)));
  const wasm = Object.keys(files).filter(name => name.endsWith('.wasm'));
  if (scripts.length !== 1 || wasm.length !== 1) throw new Error('HTML export needs an Emscripten preview with one JavaScript loader and one WASM file. Use the managed LVGL Go build.');
  // The standalone page supplies its own controls and shared player code.
  for (const name of Object.keys(files)) if (/^lvgl-go-(player|hardware)\.(js|css)$/.test(path.posix.basename(name))) delete files[name];
  const payload = (await compress(Buffer.from(JSON.stringify({ script: scripts[0], wasm: wasm[0], folder, files })), { level: 9 })).toString('base64');
  const media = (name: string) => readFile(path.join(extensionDir, 'media', name), 'utf8');
  const [template, styles, hardwareStyles, logo, player, hardware, standalone, runtimeConsole, memory, view, license] = await Promise.all([
    media('standalone.html'), media('styles.css'), media('hardware.css'), media('icon.svg'), media('player.js'), media('hardware.js'), media('standalone.js'), media('console.js'), media('memory.js'), media('view.js'),
    readFile(path.join(extensionDir, 'LICENSE.txt'), 'utf8')
  ]);
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
  const inline = (value: string) => value.replace(/<\/script/gi, '<\\/script');
  const replacements: Record<string, string> = { PROJECT: escape(project), STYLES: styles + '\n' + hardwareStyles + '\n' + sharedStyles,
    LOGO: logo, BUNDLE: payload, PLAYER: inline(player), HARDWARE: inline(hardware), STANDALONE: inline(standalone), CONSOLE: inline(runtimeConsole), MEMORY: inline(memory), VIEW: inline(view), LICENSE: license.trim() };
  return Buffer.from(template.replace(/\{\{([A-Z]+)\}\}/g, (_match, name: string) => replacements[name]));
}

const sharedStyles = `
.shared-logo,.shared-logo svg{display:block;width:32px;height:32px}.shared-project{margin-left:auto;color:var(--muted);font-size:var(--font-ui);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.shared-caption{flex:1;color:var(--muted);font-size:var(--font-meta)}canvas{display:block;touch-action:none;outline:none}
#screen-select,#display-select{display:inline-flex;align-items:center;gap:5px}#screen-select::after,#display-select::after{display:none}#screen-value,#display-value{min-width:0;overflow:hidden;text-overflow:ellipsis}.shared-chevron{width:16px;height:16px;flex:none;transform:rotate(-90deg)}
#shared-error{position:absolute;inset:0;z-index:4;display:grid;place-items:center;padding:24px;background:var(--bg);color:#ffb4a8;text-align:center;font-size:var(--font-ui)}
`;
