import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { load } from 'js-yaml';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { resolveChrome, selectBuildDirectory } from '../scripts/check.mjs';
import { runtimeBody } from './native-runtime.mjs';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const built = file => process.env.DSH_LMM_BUILD_DIR ? pathToFileURL(path.join(process.env.DSH_LMM_BUILD_DIR, file)) : new URL(`lib/${file}`, root);
const noticeFile = process.env.DSH_LMM_BUILD_DIR ? built('THIRD_PARTY_NOTICES.md') : new URL('THIRD_PARTY_NOTICES.md', root);

test('manifest and pinned dependency lock agree', async () => {
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  assert.equal(lock.version, manifest.version);
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.scripts.install, undefined);
});
test('bundle patch is valid YAML and registers exactly one client-only plugin', async () => {
  const text = await readFile(new URL('cordis.patch.yml', root), 'utf8');
  assert.notEqual(text.charCodeAt(0), 0xfeff);
  assert.deepEqual(load(text), [{ insert: [{ id: 'live-markdown-math', name: manifest.name, disabled: false }] }]);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  const host = await import(built('index.js'));
  assert.equal(host.name, 'live-markdown-math'); assert.equal(host.apply(), undefined);
});
test('package includes built entries, usage instructions and complete third-party notices', async () => {
  for (const file of [built('index.js'), built('client.js'), new URL('README.md', root), new URL('LICENSE', root), noticeFile]) {
    assert.ok((await stat(file)).size > 0, `${file} must be delivered`);
  }
  const notices = await readFile(noticeFile, 'utf8');
  assert.ok(!notices.includes('@codemirror/view'), 'native production bundle does not ship another editor');
  for (const token of ['@lezer/markdown', 'dompurify', 'katex', 'KaTeX_Main', 'SIL OPEN FONT LICENSE Version 1.1', 'Apache License']) {
    assert.ok(notices.includes(token), `Missing notice: ${token}`);
  }
});

test('isolated checks default to unique system temporary directories', async t => {
  const first = await selectBuildDirectory(), second = await selectBuildDirectory();
  t.after(() => Promise.all([first, second].map(folder => rm(folder, { recursive: true, force: true }))));
  assert.equal(path.dirname(first), await realpath(tmpdir()));
  assert.notEqual(first, second);
  assert.equal((await stat(first)).isDirectory(), true);
  assert.deepEqual(await readdir(first), []);
});

test('explicit candidate output creates no directory and rejects relative, linked or internal paths', async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'lmm-directory-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const plugin = path.join(scratch, 'plugin'); await mkdir(plugin);
  const explicit = path.join(scratch, 'candidate');
  const selected = await selectBuildDirectory({ requested: explicit, rootDir: plugin });
  assert.equal(selected, path.join(await realpath(scratch), 'candidate'));
  await assert.rejects(stat(explicit), { code: 'ENOENT' });
  for (const requested of ['', 'candidate', plugin, path.join(plugin, 'lib'), path.join(plugin, 'new', 'output')]) {
    await assert.rejects(selectBuildDirectory({ requested, rootDir: plugin }), /outside|absolute/);
  }
  await assert.rejects(selectBuildDirectory({ rootDir: plugin, temporaryDir: plugin }), /outside/);
  const alias = path.join(scratch, 'linked-plugin');
  await symlink(plugin, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(selectBuildDirectory({ requested: path.join(alias, 'candidate'), rootDir: plugin }), /outside/);
  assert.deepEqual(await readdir(plugin), [], 'unsafe checks must not create files inside the plugin');
  assert.deepEqual((await readdir(scratch)).sort(), ['linked-plugin', 'plugin'], 'explicit output must not create a temporary sibling');
});

test('Chrome override resolves a real executable and rejects a missing override without fallback', async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'lmm-chrome-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const executable = path.join(scratch, process.platform === 'win32' ? 'browser.exe' : 'browser');
  await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o755);
  assert.equal(await resolveChrome({ env: { DSH_TEST_CHROME: executable } }), executable);
  await assert.rejects(resolveChrome({ env: { DSH_TEST_CHROME: path.join(scratch, 'missing-browser') } }), /DSH_TEST_CHROME/);
});

test('Chrome discovery uses macOS applications, Windows install folders and Linux PATH', async () => {
  const cases = [
    { platform: 'darwin', env: {}, expected: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files' }, expected: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { platform: 'linux', env: { PATH: '/custom/bin:/usr/bin' }, expected: '/usr/bin/chromium' },
    { platform: 'linux', env: { DSH_TEST_CHROME: 'custom-browser', PATH: '/custom/bin' }, expected: '/custom/bin/custom-browser' },
  ];
  for (const fixture of cases) {
    const visited = [];
    const actual = await resolveChrome({ ...fixture, userHome: '/home/test', canExecute: async file => { visited.push(file); return file === fixture.expected; } });
    assert.equal(actual, fixture.expected);
    assert.equal(visited.at(-1), fixture.expected);
  }
  await assert.rejects(resolveChrome({ platform: 'linux', env: {}, canExecute: async () => false }), /Set DSH_TEST_CHROME/);
  const visited = [];
  await assert.rejects(resolveChrome({ platform: 'darwin', env: { DSH_TEST_CHROME: '/missing/browser' }, canExecute: async file => { visited.push(file); return false; } }), /DSH_TEST_CHROME/);
  assert.deepEqual(visited, ['/missing/browser'], 'an explicit override must never silently select another browser');
});

test('native fixture acceptance rejects unknown bytes before evaluating runtime code', async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'lmm-runtime-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fixture = path.join(scratch, 'client.js');
  await writeFile(fixture, 'globalThis.__lmmUnreviewedFixtureExecuted = true;');
  assert.throws(() => runtimeBody(fixture), /Unreviewed native runtime/);
  assert.equal(globalThis.__lmmUnreviewedFixtureExecuted, undefined);
});

test('isolated offline build completes within its budget and preserves delivered client bytes', async t => {
  const out = await mkdtemp(path.join(tmpdir(), 'lmm-build-regression-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  const live = new URL('lib/client.js', root), before = await digest(live);
  // The old selector regex spent minutes backtracking through embedded fonts.
  // Exercise the actual bundled assets and the safe output path together.
  await promisify(execFile)(process.execPath, ['scripts/build.mjs', '--out', out], {
    cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(await digest(live), before);
  for (const file of ['client.js', 'index.js', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok((await stat(path.join(out, file))).size > 0, `${file} must be generated`);
  }
  if (process.env.DSH_LMM_BUILD_DIR) {
    assert.equal(await digest(path.join(out, 'client.js')), await digest(built('client.js')),
      'the safe rebuild must reproduce the checked candidate client');
  }
});
