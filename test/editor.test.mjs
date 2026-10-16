import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDOM, settle } from './dom.mjs';
const dom = setupDOM();
const { createLiveEditor } = await import('../src/editor.mjs');
const { undo, redo } = await import('@codemirror/commands');
after(() => dom.window.close());
function create(value = '', extra = {}) {
  const parent = document.createElement('div'); document.body.append(parent);
  return createLiveEditor(parent, { value, ...extra });
}

test('inactive Markdown/LaTeX renders without changing source', () => {
  const raw = '# Heading\n\n**bold**\n\n$$\nx^2\n$$\n\n`$notMath$`';
  const e = create(raw);
  assert.equal(e.value, raw); assert.ok(e.view.dom.querySelector('.lmm-h1'));
  assert.ok(e.view.dom.querySelector('.lmm-strong')); assert.ok(e.view.dom.querySelector('.katex'));
  e.destroy();
});
test('source mode removes preview and restores it losslessly', () => {
  const e = create('$x$'); e.setLive(false); assert.equal(e.view.dom.querySelector('.katex'), null);
  e.setLive(true); assert.ok(e.view.dom.querySelector('.katex')); assert.equal(e.value, '$x$'); e.destroy();
});
test('clicking a rendered formula reveals raw source and puts caret inside', async () => {
  const e = create('text $x^2$');
  e.view.dom.querySelector('.lmm-formula').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await settle(); assert.equal(e.view.state.selection.main.head, 6); assert.equal(e.view.dom.querySelector('.katex'), null);
  assert.equal(e.value, 'text $x^2$'); e.destroy();
});
test('edit, undo and redo round-trip raw source', () => {
  const changes = [], e = create('one', { onChange: text => changes.push(text) });
  e.view.dispatch({ changes: { from: 3, insert: ' $x$' } });
  assert.equal(e.value, 'one $x$'); assert.equal(undo(e.view), true); assert.equal(e.value, 'one');
  assert.equal(redo(e.view), true); assert.equal(e.value, 'one $x$'); assert.equal(changes.length, 3); e.destroy();
});
test('external send-clear resets history and cannot undo a sent message', () => {
  const e = create('one'); e.view.dispatch({ changes: { from: 3, insert: ' two' } });
  e.setValue(''); assert.equal(undo(e.view), false); assert.equal(e.value, ''); e.destroy();
});
test('external restore does not emit another host write', () => {
  const changes = [], e = create('', { onChange: text => changes.push(text) });
  e.setValue('recovered'); assert.equal(e.value, 'recovered'); assert.deepEqual(changes, []); e.destroy();
});
test('Enter sends while Shift+Enter inserts a newline', () => {
  const sends = [], e = create('hi', { onSubmit: complement => sends.push(complement) });
  e.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(sends, [false]);
  e.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  assert.ok(e.value.includes('\n')); assert.equal(sends.length, 1); e.destroy();
});
test('IME confirmation never sends, including immediate post-composition Enter', async () => {
  const sends = [], e = create('中文', { onSubmit: x => sends.push(x) });
  e.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  e.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  e.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  e.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(); assert.equal(sends.length, 0); e.destroy();
});
test('raw HTML and Markdown images create no executable or external elements', () => {
  const raw = '<img src="https://example.invalid/tracker" onerror="alert(1)">\n\n![image](https://example.invalid/a.png)';
  const e = create(raw); assert.equal(e.value, raw);
  assert.equal(e.view.dom.querySelector('img,iframe,script,a'), null); e.destroy();
});
test('oversize document degrades to source', () => {
  const raw = '$x$' + 'a'.repeat(100001), e = create(raw);
  assert.equal(e.limited, true); assert.equal(e.value, raw); assert.equal(e.view.dom.querySelector('.katex'), null); e.destroy();
});
test('CRLF/CR host restoration clamps selection to the normalized document', () => {
  for (const raw of ['a\r\nb\r\nc', 'a\rb\rc', 'a\r\nb\rc']) {
    const changes = [], e = create('1234567890', { onChange: text => changes.push(text) });
    e.view.dispatch({ changes: { from: 10, insert: '!' }, selection: { anchor: 11 } });
    e.setLive(false); e.setReadOnly(true); changes.length = 0;
    assert.doesNotThrow(() => e.setValue(raw));
    assert.equal(e.value, 'a\nb\nc'); assert.equal(e.view.state.selection.main.head, 5);
    assert.equal(undo(e.view), false); assert.deepEqual(changes, []);
    assert.equal(e.view.contentDOM.getAttribute('contenteditable'), 'false');
    e.setValue('$x$'); assert.equal(e.view.dom.querySelector('.katex'), null);
    e.setLive(true); assert.ok(e.view.dom.querySelector('.katex')); e.destroy();
  }
});
test('formula-internal HTML/backticks render without Markdown replacement conflicts', () => {
  for (const raw of ['$a<b>c$', '$a < b > c$', '$\\text{`x`}$']) {
    const e = create(raw); assert.equal(e.value, raw);
    assert.ok(e.view.dom.querySelector('.katex'), raw);
    assert.equal(e.view.dom.querySelector('.lmm-math-error'), null);
    assert.equal(e.view.dom.querySelector('.lmm-code'), null); e.destroy();
  }
});
test('external code after a formula retains its literal Markdown decorations', () => {
  const raw = '$\\text{`x}$ `$y$ @ref`', e = create(raw);
  assert.equal(e.view.dom.querySelectorAll('.lmm-formula').length, 1);
  assert.equal(e.view.dom.querySelector('.lmm-code')?.textContent, '$y$ @ref');
  assert.equal(e.value, raw); e.destroy();
});
test('source-mode edits stay fast and live preview reanalyzes the current document', () => {
  const e = create('', { live: false }), raw = '\\'.repeat(100000);
  const start = performance.now(); e.view.dispatch({ changes: { from: 0, insert: raw } });
  assert.ok(performance.now() - start < 1500); assert.equal(e.value, raw);
  e.view.dispatch({ changes: { from: 0, to: e.value.length, insert: '$a<b>c$' } });
  assert.equal(e.view.dom.querySelector('.katex'), null);
  e.setLive(true); assert.ok(e.view.dom.querySelector('.katex')); e.destroy();
});
function drop(e, transfer) {
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  e.view.contentDOM.dispatchEvent(event); return event;
}
test('plain-text drop is handled by CodeMirror, not the file handoff', () => {
  let files = 0; const e = create('abc', { onFiles: () => files++ });
  e.view.posAtCoords = () => 1; // Only geometry is stubbed in jsdom.
  const event = drop(e, { files: [], types: ['text/plain'], getData: () => 'TEXT' });
  assert.equal(files, 0); assert.equal(e.value, 'aTEXTbc'); assert.equal(event.defaultPrevented, true);
  assert.equal(undo(e.view), true); assert.equal(e.value, 'abc'); e.destroy();
});
test('internal text drag moves the selection through CodeMirror', () => {
  let files = 0; const e = create('abc', { onFiles: () => files++ });
  const data = { files: [], types: ['text/plain'], text: '', setData(_type, value) { this.text = value; }, getData() { return this.text; } };
  e.view.dispatch({ selection: { anchor: 0, head: 1 } });
  const start = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(start, 'dataTransfer', { value: data }); e.view.contentDOM.dispatchEvent(start);
  e.view.posAtCoords = () => 3; drop(e, data);
  assert.equal(e.value, 'bca'); assert.equal(files, 0); e.destroy();
});
test('file drops hand off once without importing file content; empty drops are untouched', () => {
  let files = 0; const e = create('abc', { onFiles: () => files++ });
  const event = drop(e, { files: [new dom.window.File(['private'], 'a.txt')], types: ['Files'] });
  assert.equal(event.defaultPrevented, true); assert.equal(files, 1); assert.equal(e.value, 'abc');
  assert.equal(drop(e, null).defaultPrevented, false); assert.equal(files, 1); e.destroy();
});
test('file paste is not silently imported and asks for native fallback', () => {
  let fallback = 0; const e = create('text', { onFiles: () => fallback++ });
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files: [new dom.window.File(['x'], 'a.txt')] } });
  e.view.contentDOM.dispatchEvent(ev); assert.equal(fallback, 1); assert.equal(e.value, 'text'); assert.equal(ev.defaultPrevented, true); e.destroy();
});
