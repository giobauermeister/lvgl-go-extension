const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const path = require('node:path');

const run = promisify(execFile);

async function fixture(t, { tag = 'v1.0.0', existing, missing } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'artifacts'));
  await mkdir(path.join(directory, 'bin'));
  for (const name of [`lvgl-go-${tag.slice(1)}.vsix`, 'lvgl-go-pwa.zip']) {
    if (name !== missing) await writeFile(path.join(directory, 'artifacts', name), 'tested package');
  }
  const log = path.join(directory, 'calls.jsonl');
  await writeFile(log, '');
  // All release operations go to this local stub; no GitHub credentials or API calls.
  await writeFile(path.join(directory, 'bin', 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[1] === 'view') {
  if (!process.env.RELEASE_TEST_EXISTING) process.exit(1);
  process.stdout.write(process.env.RELEASE_TEST_EXISTING);
}
if (args[1] === 'upload' && !fs.statSync(args[3]).size) process.exit(2);
`, { mode: 0o755 });
  const workflow = await readFile(path.join(__dirname, '../.github/workflows/build.yml'), 'utf8');
  const step = workflow.split('      - name: Publish GitHub release\n')[1];
  assert(step, 'Release step must exist');
  const script = step.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const execute = () => run('bash', ['-e', '-c', script], { cwd: directory, env: {
    ...process.env,
    PATH: path.join(directory, 'bin') + path.delimiter + process.env.PATH,
    RELEASE_TAG: tag,
    RELEASE_TEST_LOG: log,
    RELEASE_TEST_EXISTING: existing ? JSON.stringify(existing) : ''
  } });
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { execute, calls };
}

test('release fails with the missing package name before making any GitHub changes', async t => {
  const f = await fixture(t, { missing: 'lvgl-go-pwa.zip' });
  await assert.rejects(f.execute(), error => {
    assert.match(error.stderr, /Missing or empty release asset: artifacts\/lvgl-go-pwa\.zip/);
    return error.code === 1;
  });
  assert.deepEqual(await f.calls(), []);
});

test('new releases upload both packages before publishing and mark prerelease versions', async t => {
  for (const tag of ['v1.0.0', 'v1.1.0-beta.1']) {
    const f = await fixture(t, { tag });
    await f.execute();
    const calls = await f.calls();
    assert.deepEqual(calls.map(args => args[1]), ['view', 'create', 'upload', 'upload', 'edit']);
    assert(calls[1].includes('--verify-tag'));
    assert(calls[1].includes('--draft'));
    assert.equal(calls[1].includes('--prerelease'), tag.includes('-'));
    assert.deepEqual(calls[2], ['release', 'upload', tag, `artifacts/lvgl-go-${tag.slice(1)}.vsix`]);
    assert.deepEqual(calls[3], ['release', 'upload', tag, 'artifacts/lvgl-go-pwa.zip']);
    assert.deepEqual(calls[4], ['release', 'edit', tag, '--draft=false']);
  }
});

test('release retries preserve existing assets and only publish drafts after completing uploads', async t => {
  for (const isDraft of [true, false]) {
    const f = await fixture(t, { existing: { isDraft, assets: [{ name: 'lvgl-go-1.0.0.vsix' }] } });
    await f.execute();
    const calls = await f.calls();
    assert.deepEqual(calls.map(args => args[1]), isDraft ? ['view', 'upload', 'edit'] : ['view', 'upload']);
    assert.deepEqual(calls[1], ['release', 'upload', 'v1.0.0', 'artifacts/lvgl-go-pwa.zip']);
  }
  const complete = await fixture(t, { existing: { isDraft: false,
    assets: [{ name: 'lvgl-go-1.0.0.vsix' }, { name: 'lvgl-go-pwa.zip' }] } });
  await complete.execute();
  assert.deepEqual((await complete.calls()).map(args => args[1]), ['view']);
});
