import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EditorView } from '@codemirror/view';
import { setupDOM } from './dom.mjs';
const dom = setupDOM();
const html = await readFile(new URL('../demo/index.html', import.meta.url), 'utf8');
document.documentElement.innerHTML = html;
const scripts = document.querySelectorAll('script');
assert.equal(scripts.length, 1);
vm.runInThisContext(scripts[0].textContent, { filename: 'offline-demo.js' });
const view = EditorView.findFromDOM(document.querySelector('.cm-content'));
after(() => { view.destroy(); dom.window.close(); });

test('standalone demo starts and preserves literal double-dollar display delimiters', () => {
  assert.match(view.state.doc.toString(), /\n\$\$\nf\(x\)/);
  assert.match(view.state.doc.toString(), /\n\$\$\n/);
  assert.ok(document.querySelectorAll('.lmm-formula').length >= 2);
  assert.equal(document.querySelector('#source').textContent, view.state.doc.toString());
});
test('demo source/live switch is lossless and math sample renders', () => {
  document.querySelector('[data-sample="math"]').click();
  const before = view.state.doc.toString();
  document.querySelector('[data-mode="source"]').click();
  assert.equal(document.querySelector('.lmm-formula'), null);
  document.querySelector('[data-mode="live"]').click();
  assert.equal(view.state.doc.toString(), before);
  assert.ok(document.querySelectorAll('.lmm-formula').length >= 3);
});
test('demo is offline and includes copyright and font license notices', () => {
  document.querySelector('[data-sample="security"]').click();
  // CodeMirror may insert an inert <img class="cm-widgetBuffer"> without src.
  const externalElement = document.querySelector('img[src], img[srcset], [onerror], iframe, script[src], link[rel="stylesheet"]');
  assert.ok(!externalElement, `Unexpected asset element: ${externalElement?.outerHTML.slice(0, 250)}`);
  const styles = [...document.querySelectorAll('style')].map(s => s.textContent).join('\n');
  assert.equal(/url\(["']?https?:/i.test(styles), false, 'CSS must not request remote assets');
  assert.ok(/url\(["']?data:[^;]+;base64,/.test(styles), 'fonts must be inlined as data URLs');
  assert.ok(document.body.textContent.includes('SIL OPEN FONT LICENSE Version 1.1'), 'font license must be readable');
  document.querySelector('#send').click();
  assert.match(document.querySelector('#notice').textContent, /不访问 DSH 或网络/);
});
