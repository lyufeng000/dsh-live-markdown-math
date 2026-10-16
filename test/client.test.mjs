import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { setupDOM, settle } from './dom.mjs';
import { runtimePath, loadNativeRuntime, createFixture } from './native-runtime.mjs';
const dom = setupDOM();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let plugin;
window.__ModuleLoader__ = { load({ id, factory }) {
  assert.equal(id, 'dsh-live-markdown-math');
  plugin = factory(name => { assert.equal(name, 'react'); return React; });
} };
const built = process.env.DSH_LMM_BUILD_DIR ? path.join(process.env.DSH_LMM_BUILD_DIR, 'client.js') : new URL('../lib/client.js', import.meta.url);
vm.runInThisContext(await readFile(built, 'utf8'), { filename: 'built-client.js' });
const api = runtimePath ? loadNativeRuntime() : null;
after(() => dom.window.close());

function host(editor) {
  const binding = { ctx: {} }, registrations = [], effects = [];
  const ctx = {
    sessions: { binding: id => id === 's1' ? binding : undefined },
    conversation: { input: { for: scope => { assert.equal(scope, binding.ctx); return { editor }; } } },
    slots: {
      register(options, component) {
        const r = { options, component, disposed: false }; registrations.push(r);
        return () => { r.disposed = true; };
      },
      inject(name, fn) { assert.equal(name, 'conversation.input.overlay'); const offs = [...fn()]; return () => offs.forEach(off => off()); },
    },
    effect(fn) { effects.push(fn()); },
  };
  return { ctx, registrations, dispose() { effects.forEach(fn => fn()); } };
}

test('built native module declares only actual service dependencies', () => {
  assert.deepEqual(plugin.inject, ['slots', 'conversation', 'sessions']);
  assert.equal(plugin.name, 'live-markdown-math'); assert.equal(plugin.revision, 'native-rc2-9');
  assert.equal(plugin.NativeToggle, undefined); assert.equal(plugin.LiveComposer, undefined);
});
test('private native seam fails open when incompatible, missing or disposed', () => {
  const f = host({});
  assert.equal(plugin.nativeEditor(f.ctx, 's1'), null);
  assert.equal(plugin.nativeEditor(f.ctx, 'missing'), null);
  assert.equal(plugin.nativeEditor({}, 's1'), null);
});
test('apply registers lifecycle-only overlay, no composer takeover or button', () => {
  const f = host(null); plugin.apply(f.ctx);
  assert.equal(f.registrations.length, 1);
  const r = f.registrations[0];
  assert.equal(r.options.name, 'conversation.input.overlay');
  assert.equal(r.options.id, 'live-markdown-math-native');
  assert.equal(r.options.inject('s1').editor, null);
  assert.ok(document.head.querySelector('[data-plugin="dsh-live-markdown-math"][data-revision="native-rc2-9"]'));
  f.dispose(); assert.equal(r.disposed, true);
  assert.equal(document.head.querySelector('[data-plugin="dsh-live-markdown-math"]'), null);
});
test('React lifecycle decorates the same native editor without rendering its own UI', { skip: !api }, async () => {
  const f = createFixture(api, { text: '**hello**' }), h = host(f.editor);
  plugin.apply(h.ctx);
  const registration = h.registrations[0], props = registration.options.inject('s1');
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    assert.equal(props.editor, f.editor);
    await act(async () => { root.render(React.createElement(registration.component, props)); await settle(); });
    assert.equal(container.childNodes.length, 0);
    assert.equal(f.editor.getRootElement(), f.root);
    assert.equal(f.root.dataset.lmmNative, 'native-rc2-9');
    assert.equal(f.runtime.projection.clipboardText, '**hello**');
    await act(async () => root.unmount());
    assert.equal(f.root.hasAttribute('data-lmm-native'), false);
    assert.equal(f.runtime.projection.clipboardText, '**hello**');
  } finally { h.dispose(); container.remove(); f.dispose(); }
});
test('two lifecycle mounts ref-count one adapter and dispose without touching the editor', { skip: !api }, async () => {
  const f = createFixture(api, { text: '# title' }), manager = plugin.createManager();
  try {
    const a = manager.acquire(f.editor), b = manager.acquire(f.editor); await settle();
    assert.equal(document.querySelectorAll('.lmm-native-layer').length, 1);
    a(); assert.equal(f.root.hasAttribute('data-lmm-native'), true);
    b(); assert.equal(f.root.hasAttribute('data-lmm-native'), false);
    assert.equal(document.querySelectorAll('.lmm-native-layer').length, 0);
    a(); b(); manager.dispose(); manager.acquire(f.editor)();
    assert.equal(f.runtime.projection.clipboardText, '# title');
  } finally { manager.dispose(); f.dispose(); }
});

test('a reloaded client replaces the previous instance instead of stacking it', () => {
  const f = host(null);
  plugin.apply(f.ctx);
  assert.equal(document.head.querySelectorAll('style[data-plugin="dsh-live-markdown-math"]').length, 1);
  const first = document.head.querySelector('style[data-plugin="dsh-live-markdown-math"]');
  const stale = document.createElement('div');
  stale.className = 'lmm-native-layer'; document.body.append(stale);
  const root = document.createElement('div');
  root.setAttribute('data-lmm-native', 'native-rc2-8'); root.setAttribute('data-lmm-composing', 'true');
  document.body.append(root);
  // A hot-reloaded client half runs apply again without the old effect necessarily
  // having been disposed: the new instance must take over, never stack.
  const second = host(null);
  plugin.apply(second.ctx);
  assert.equal(document.head.querySelectorAll('style[data-plugin="dsh-live-markdown-math"]').length, 1, 'one stylesheet');
  assert.equal(document.head.contains(first), false, 'the previous stylesheet is removed');
  assert.equal(document.body.contains(stale), false, 'the previous overlay layer is removed');
  assert.equal(root.hasAttribute('data-lmm-native'), false, 'stale root attributes are cleared');
  assert.equal(root.hasAttribute('data-lmm-composing'), false);
  second.dispose(); f.dispose(); stale.remove(); root.remove();
});

test('live source never registers takeover, writes whole drafts or owns input/file/send events', async () => {
  const client = await readFile(new URL('../src/client.mjs', import.meta.url), 'utf8');
  const adapter = await readFile(new URL('../src/native-adapter.mjs', import.meta.url), 'utf8');
  assert.ok(!/conversation\.composer|conversation\.input\.left|createLiveEditor|DraftMirror/.test(client));
  assert.ok(!/\.setRootElement\(|\.setEditable\(|\.setDraft\(|\.submit\(|\.insertText\(/.test(client + adapter));
  assert.ok(!/addEventListener\(['"](?:paste|drop|keydown|beforeinput|input)['"]/.test(adapter));
  // The single deliberate document write is the inherited list marker.
  assert.match(adapter, /function continueList/);
  assert.equal([...adapter.matchAll(/block\.append\(/g)].length, 1, 'exactly one node insertion');
  assert.equal([...adapter.matchAll(/\.insertText\(|\.insertParagraph\(|\.setTextContent\(/g)].length, 0, 'no text rewriting');
});
