// Exercise the same automatic build and tunnel pipeline without the VS Code UI.
// node scripts/preview-project.js /path/to/LVGL/project [--local]
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const QRCode = require('qrcode');
const { readConfig } = require('../dist/config');
const { prepareManagedBuild } = require('../dist/project');
const { PreviewServer } = require('../dist/server');
const { Builder } = require('../dist/builder');
const { ensureCloudflared, InternetTunnel } = require('../dist/tunnel');

async function main() {
  if (!process.argv[2]) throw new Error('Pass the LVGL project folder containing project.xml.');
  const root = path.resolve(__dirname, '..');
  const project = path.resolve(process.argv[2]);
  const storage = path.join(root, '.lvgl-go', 'projects', createHash('sha256').update(project).digest('hex').slice(0, 20));
  const config = await readConfig(project, root, storage);
  // Optional SDK cache override for the local development harness.
  if (process.env.LVGL_GO_EM_CACHE) for (const step of config.build) step.env = { ...step.env, EM_CACHE: process.env.LVGL_GO_EM_CACHE };
  const server = new PreviewServer(await fs.readFile(path.join(root, 'media', 'preview.html'), 'utf8'), config.entry,
    { appUrl: process.argv.includes('--local') ? undefined : config.appUrl });
  let builder, tunnel;
  const stop = async () => { await builder?.stop(); await tunnel?.stop(); await server.stop(); };
  try {
    await server.start(path.join(storage, 'published'), '127.0.0.1', 0, '127.0.0.1');
    if (!process.argv.includes('--local')) {
      const executable = await ensureCloudflared(path.join(root, '.lvgl-go'), process.env.LVGL_GO_CLOUDFLARED ?? config.tunnel.command, console.log);
      tunnel = new InternetTunnel(console.log, () => server.setState('error', 'Tunnel disconnected.'));
      const origin = await tunnel.start(executable, server.localOrigin, storage);
      server.setPublicOrigin(origin, 'poll');
    }
    builder = new Builder(config, console.log, (state, message) => server.setState(state, message), async () => {
      await server.publish(config.outputDir);
      console.log('Published successful WASM build.');
    }, () => prepareManagedBuild(config));
    await QRCode.toFile(path.join(root, '.lvgl-go', 'internet-qr.png'), server.pairingUrl, { width: 440, margin: 3 });
    await fs.writeFile(path.join(root, '.lvgl-go', 'internet-session.json'), JSON.stringify({ pairingUrl: server.pairingUrl, apiUrl: server.url, localOrigin: server.localOrigin, project, pid: process.pid }));
    console.log('Preview:', server.pairingUrl);
    console.log('QR:', path.join(root, '.lvgl-go', 'internet-qr.png'));
    builder.request(true);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)); });
  } catch (error) { await stop(); throw error; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
