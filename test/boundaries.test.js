const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm, symlink } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateAssets } = require('../dist/assets');
const { prepareManagedBuild } = require('../dist/project');

test('preloaded folders accept public assets and reject sources, configuration and symlinks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets');
  await mkdir(path.join(assets, 'images'), { recursive: true });
  await writeFile(path.join(assets, 'images', 'logo.png'), 'image');
  await writeFile(path.join(assets, 'data.json'), '{}');
  await validateAssets(assets);
  for (const file of ['project.xml', 'private.c', 'private.h', 'library.a', 'debug.map', 'lvgl-go.json', 'package.json', '.env', 'index.js']) {
    const input = path.join(assets, file);
    await writeFile(input, 'private input');
    // Validation must run before the managed build reads or compiles the project.
    await assert.rejects(prepareManagedBuild({ managedBuild: true, runtime: { assetsDir: assets } }), /private or unsupported file/);
    await rm(input);
  }
  if (process.platform !== 'win32') {
    await symlink(path.join(assets, 'images'), path.join(assets, 'linked'));
    await assert.rejects(validateAssets(assets), /private or unsupported file/);
    await rm(path.join(assets, 'linked'));
    await symlink(assets, path.join(root, 'linked-assets'));
    await assert.rejects(validateAssets(path.join(root, 'linked-assets')), /not a symlink/);
  }
});
