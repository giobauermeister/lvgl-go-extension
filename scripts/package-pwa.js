// Package the static PWA for deployment to an HTTPS host.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startupImages } = require('./startup-images');
const root = path.resolve(__dirname, '..');

async function buildPwa(output) {
  // This dedicated generated folder is also offered for direct upload.
  // Recreate it so stale files cannot bypass the ZIP's explicit file list.
  await fs.rm(output, { recursive: true, force: true });
  const app = path.join(output, 'app');
  await fs.mkdir(app, { recursive: true });
  const files = [];
  for (const name of ['app.js', 'styles.css', 'session.js', 'updates.js', 'player.js', 'console.js', 'memory.js', 'view.js', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', ...startupImages.map(image => image.name)]) {
    await fs.copyFile(path.join(root, 'media', name), path.join(app, name));
    files.push('app/' + name);
  }
  const html = await fs.readFile(path.join(root, 'media', 'preview.html'));
  await fs.writeFile(path.join(app, 'index.html'), html);
  await fs.writeFile(path.join(output, 'index.html'), html);
  await fs.copyFile(require.resolve('jsqr'), path.join(app, 'qr.js'));
  const license = path.join(path.dirname(require.resolve('jsqr/package.json')), 'LICENSE');
  await fs.copyFile(license, path.join(app, 'jsqr-LICENSE.txt'));
  await fs.writeFile(path.join(output, '_redirects'), '/  /app/  302!\n');
  await fs.writeFile(path.join(output, '_headers'), `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; frame-src 'self' https:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Permissions-Policy: camera=(self), microphone=()
/app/*
  Cache-Control: public, max-age=0, must-revalidate
/app/sw.js
  Cache-Control: no-cache
  Service-Worker-Allowed: /app/
`);
  await fs.copyFile(path.join(root, 'LICENSE.txt'), path.join(output, 'LICENSE.txt'));
  files.push('app/index.html', 'app/qr.js', 'app/jsqr-LICENSE.txt', 'index.html', '_redirects', '_headers', 'LICENSE.txt');
  return files;
}

async function main() {
  const output = path.join(root, 'artifacts', 'pwa');
  const files = await buildPwa(output);
  const archive = path.join(root, 'artifacts', 'lvgl-go-pwa.zip');
  execFileSync('python3', ['-c',
    'import sys,json,zipfile,pathlib; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [z.write(root/f,f) for f in json.loads(sys.argv[3])]; z.close()',
    output, archive, JSON.stringify(files)], { stdio: 'inherit' });
  console.log(`Static PWA folder: ${output}\nZIP: ${archive}\n${files.length} static files. Serve app/ over HTTPS. Optional host header and redirect rules are included.`);
}
module.exports = { buildPwa };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
