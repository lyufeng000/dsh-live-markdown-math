import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDOM, settle } from './dom.mjs';
import { runtimePath, loadNativeRuntime, createFixture } from './native-runtime.mjs';
import { mountNativeAdapter } from '../src/native-adapter.mjs';
import { createChatMath, renderChatMath } from '../src/chat-math.mjs';

const dom = setupDOM();
const api = runtimePath ? loadNativeRuntime() : null;
after(() => dom.window.close());
const native = (name, fn) => test(name, { skip: !api && 'DSH_NATIVE_RUNTIME required' }, fn);
const wait = () => new Promise(resolve => setTimeout(resolve, 50));

for (const text of ['1. saved\n', '1. \n', 'keep\n- \n', '```\n- code\n']) {
  native(`mount and programmatic draft restoration preserve ${JSON.stringify(text)}`, async () => {
    const f = createFixture(api, { text });
    const adapter = mountNativeAdapter(f.editor);
    try {
      await settle();
      assert.equal(f.runtime.projection.clipboardText, text, 'mount must not edit saved text');
      f.runtime.setDraft(text);
      assert.equal(f.runtime.projection.clipboardText, text, 'setDraft must not invent an Enter');
    } finally { adapter.dispose(); f.dispose(); }
  });
}

native('pasting a multiline list preserves the exact clipboard text', async () => {
  const f = createFixture(api, { text: '' }), adapter = mountNativeAdapter(f.editor);
  try {
    f.editor.update(() => api.getRoot().selectEnd().insertRawText('1. pasted\n'), { discrete: true, tag: 'paste' });
    assert.equal(f.runtime.projection.clipboardText, '1. pasted\n');
  } finally { adapter.dispose(); f.dispose(); }
});

native('deferred native beforeinput commits keep the newline intent until Lexical transforms', async () => {
  const f = createFixture(api, { text: '1. item' }), adapter = mountNativeAdapter(f.editor);
  const commit = event => {
    event.preventDefault(); event.stopImmediatePropagation();
    f.editor.update(() => api.getRoot().selectEnd().insertLineBreak());
  };
  f.root.addEventListener('beforeinput', commit, true);
  try {
    f.root.dispatchEvent(new dom.window.InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true }));
    await settle();
    assert.equal(f.runtime.projection.clipboardText, '1. item\n2. ');
  } finally { f.root.removeEventListener('beforeinput', commit, true); adapter.dispose(); f.dispose(); }
});

native('a real newline in a fenced code block does not continue a list', async () => {
  const f = createFixture(api, { text: '```\n- literal' }), adapter = mountNativeAdapter(f.editor);
  try {
    f.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
    assert.equal(f.runtime.projection.clipboardText, '```\n- literal\n');
  } finally { adapter.dispose(); f.dispose(); }
});

native('empty list exit retains the preceding line break', async () => {
  const f = createFixture(api, { text: '' }), adapter = mountNativeAdapter(f.editor);
  try {
    f.editor.update(() => api.getRoot().selectEnd().insertRawText('- item\n- '), { discrete: true });
    f.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
    assert.equal(f.runtime.projection.clipboardText, '- item\n');
  } finally { adapter.dispose(); f.dispose(); }
});

native('a cancelled newline intent cannot leak into a later draft restoration', async () => {
  const f = createFixture(api, { text: '1. item' }), adapter = mountNativeAdapter(f.editor);
  const cancel = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  f.root.addEventListener('keydown', cancel, true);
  try {
    f.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
    assert.equal(f.runtime.projection.clipboardText, '1. item');
    f.runtime.setDraft('1. item\n');
    assert.equal(f.runtime.projection.clipboardText, '1. item\n');
  } finally { f.root.removeEventListener('keydown', cancel, true); adapter.dispose(); f.dispose(); }
});

native('identical list newline gestures can be repeated after undo', async () => {
  const f = createFixture(api, { text: '1. item' }), adapter = mountNativeAdapter(f.editor);
  const enter = async () => {
    f.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
  };
  try {
    await settle();
    await enter();
    assert.equal(f.runtime.projection.clipboardText, '1. item\n2. ');
    f.editor.dispatchCommand(api.undo, undefined); await settle();
    assert.equal(f.runtime.projection.clipboardText, '1. item');
    await enter();
    assert.equal(f.runtime.projection.clipboardText, '1. item\n2. ', 'not suppressed by an old text cache');
  } finally { adapter.dispose(); f.dispose(); }
});

function bubble(text) {
  const flow = document.createElement('div'); flow.setAttribute('data-chat-flow', '');
  flow.innerHTML = '<div data-chat-flow-kind="user"><span class="_plainRun_fbulu_6"></span><span data-ref-chip="session">$reference$</span><div data-message-attachments><span>$file$.txt</span></div><button>$action$</button></div>';
  flow.querySelector('._plainRun_fbulu_6').textContent = text;
  document.body.append(flow);
  return flow;
}

test('sent formula rendering never modifies reference chips, attachments or action labels', () => {
  const flow = bubble('$x$');
  try {
    assert.equal(renderChatMath(document), 1);
    for (const element of flow.querySelectorAll('[data-ref-chip], [data-message-attachments], button')) {
      assert.equal(element.querySelector('.lmm-chat-formula'), null);
    }
  } finally { flow.remove(); }
});

test('disabling the chat enhancer restores source and original native text nodes', () => {
  const source = 'before $x$ after', flow = bubble(source), run = flow.querySelector('._plainRun_fbulu_6');
  const original = run.firstChild, watcher = createChatMath(document);
  try {
    assert.ok(run.querySelector('.katex'));
    watcher.dispose();
    assert.equal(run.textContent, source);
    assert.equal(run.firstChild, original, 'return React-owned text node, not a replacement');
    assert.equal(flow.querySelector('.lmm-chat-formula'), null);
    watcher.dispose();
  } finally { watcher.dispose(); flow.remove(); }
});

test('unloading chat rendering cannot overwrite a newer native repaint', () => {
  const flow = bubble('$x$'), run = flow.querySelector('._plainRun_fbulu_6');
  const watcher = createChatMath(document);
  try {
    run.textContent = 'new native message';
    watcher.dispose();
    assert.equal(run.textContent, 'new native message');
    assert.equal(run.hasAttribute('data-lmm-chat-math'), false);
  } finally { watcher.dispose(); flow.remove(); }
});

test('unloading preserves foreign character-data updates beside formulas', () => {
  const flow = bubble('before $x$ after'), run = flow.querySelector('._plainRun_fbulu_6');
  const watcher = createChatMath(document);
  try {
    run.firstChild.data = 'updated ';
    watcher.dispose();
    assert.equal(run.textContent, 'updated $x$ after');
    assert.equal(run.querySelector('.katex'), null);
  } finally { watcher.dispose(); flow.remove(); }
});

test('chat observation survives conversation flow replacement', async () => {
  const first = bubble('old message'), watcher = createChatMath(document, { debounce: 5 });
  let second;
  try {
    first.remove(); second = bubble('new $x$ message');
    await wait();
    assert.ok(second.querySelector('._plainRun_fbulu_6 .katex'));
  } finally { watcher.dispose(); first.remove(); second?.remove(); }
});
