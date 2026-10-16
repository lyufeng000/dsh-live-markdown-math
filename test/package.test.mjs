import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { load } from 'js-yaml';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
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
