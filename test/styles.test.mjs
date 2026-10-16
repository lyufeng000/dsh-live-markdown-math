import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const css = await fs.readFile(new URL('../src/native.css', import.meta.url), 'utf8');
test('native typography is root-scoped and inherits host foreground and color scheme', () => {
  assert.match(css, /\[data-lmm-native\]/);
  assert.match(css, /color-scheme:\s*inherit/);
  assert.match(css, /var\(--dsw-alias-label-secondary, currentColor\)/);
  assert.ok(!/\.lmm-send|\.cm-editor|color:\s*(?:white|black|#)/.test(css));
});
test('formula paint never consumes pointer events or replaces editor children', () => {
  assert.match(css, /\.lmm-native-layer[^}]*pointer-events:\s*none/);
  assert.match(css, /\[data-lmm-math="true"\][^}]*width:\s*var\(--lmm-width\)/);
  assert.match(css, /\[data-lmm-math="true"\][^}]*vertical-align:\s*middle/);
  assert.match(css, /@media print/);
  // Generated content is allowed only for the view-only list label.
  const generated = css.split('@media print')[0].split('}').filter(block => /content:\s*/.test(block));
  assert.equal(generated.length, 1, 'only the list label rule may generate content');
  assert.match(generated[0], /\[data-lmm-role~="ulm"\]/);
  assert.match(generated[0], /\[data-lmm-role~="olm"\]/);
  assert.match(generated[0], /content:\s*var\(--lmm-list-label/);
  assert.ok(!/display:\s*none(?!.*print)/.test(css.split('@media print')[0]));
});
// Regression: zeroing the font size (or the line-height) hid the native caret
// inside headings, emphasis markers and formula placeholders. Hiding must keep
// the source's font metrics and cancel only its advance.
test('hidden source keeps caret metrics and cancels its advance', () => {
  assert.ok(!/font-size:\s*0/.test(css), 'hidden source must never zero its font size');
  assert.match(css, /-webkit-text-fill-color:\s*transparent/);
  assert.match(css, /letter-spacing:\s*var\(--lmm-advance/);
  assert.match(css, /@media print[^}]*\}[^}]*letter-spacing:\s*normal\s*!important/);
  assert.match(css, /@media print[^}]*\}[^}]*text-fill-color:\s*currentColor\s*!important/);
});
