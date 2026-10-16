import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import React, { act } from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import { EditorView } from '@codemirror/view';
import { setupDOM, settle, source, fakeBridge } from './dom.mjs';

// Optional, offline integration against extracted DSH 0.2.0-rc.2 artifacts.
// Both paths are required; normal npm test neither fetches nor installs DSH.
// A supplied but incompatible artifact must fail loudly, not become a skip.
const enabled = !!(process.env.DSH_SLOT_CORE && process.env.DSH_RENDERER);
const integration = { skip: enabled ? false : 'set both DSH_SLOT_CORE and DSH_RENDERER to extracted rc.2 files' };
const h = React.createElement;
let dom, runtime;

function loadClient(code, filename, expectedId, dependencies) {
  let loaded;
  const previous = window.__ModuleLoader__;
  window.__ModuleLoader__ = { load({ id, factory }) {
    assert.equal(id, expectedId);
    assert.equal(loaded, undefined, 'a client artifact must register exactly once');
    loaded = factory(name => {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected runtime dependency: ${name}`);
      return dependencies[name];
    });
  } };
  try {
    vm.runInThisContext(code, { filename });
    assert.ok(loaded, `${expectedId} must register with ModuleLoader`);
    return loaded;
  } finally {
    if (previous === undefined) delete window.__ModuleLoader__;
    else window.__ModuleLoader__ = previous;
  }
}

before(async () => {
  if (!enabled) return;
  dom = setupDOM();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const slots = await import(pathToFileURL(process.env.DSH_SLOT_CORE).href);
  const rendererSource = await readFile(process.env.DSH_RENDERER, 'utf8');
  const returnMarker = 'return module.exports;';
  assert.equal(rendererSource.split(returnMarker).length, 2, 'expected the rc.2 renderer ModuleLoader wrapper');
  // Expose private test seats IN MEMORY ONLY. Election, session identity, inject
  // caching, overlay fallback, and component lifecycles remain the real renderer.
  // Neither the extracted artifact nor the plugin's public exports are changed.
  const instrumented = rendererSource.replace(returnMarker,
    'return { ...module.exports, __test: { HostContext, RootBindingContext, ScopeBindingContext, SlotOutlet } };');
  const renderer = loadClient(instrumented, process.env.DSH_RENDERER, '@deepseek-ai/dsh-client-ui-renderer', {
    react: React,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
    'react/jsx-runtime': JSXRuntime,
    '@deepseek-ai/dsh-client-ui-slots': slots,
    // The service is declared at module evaluation but is never instantiated:
    // this fixture supplies its host face directly around the actual SlotCore.
    '@deepseek-ai/cordis': { Service: class {
      constructor() { throw new Error('the renderer fixture must not bootstrap Cordis'); }
    } },
  });
  const plugin = loadClient(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'),
    'built-live-markdown-math-client.js', 'dsh-live-markdown-math', { react: React });
  runtime = { SlotCore: slots.SlotCore, renderer: renderer.__test, plugin };
});
after(() => dom?.window.close());

async function mount(t) {
  const { SlotCore, renderer, plugin } = runtime;
  const { HostContext, RootBindingContext, ScopeBindingContext, SlotOutlet } = renderer;
  const core = new SlotCore();
  const offRoot = core.register({ name: 'root', children: {
    'conversation.input.left': { kind: 'list', scope: 'session' },
    'conversation.composer': { kind: 'chain', scope: 'session' },
  } }, () => null);
  const sessions = new Map([['s1', fakeBridge('hello ')], ['s2', fakeBridge('second draft')]]);
  const bindings = new Map(), facades = new Map(), writesAttempted = [], sendsAttempted = [];
  for (const [id, b] of sessions) {
    b.session.set({ ...b.readSession(), sessionId: id });
    const binding = { key: id, ctx: {}, session: b.session, hooks: { session: b.session }, keyedHooks: {}, props: { sessionId: id } };
    bindings.set(id, binding);
    facades.set(binding.ctx, { state: b.input, actions: {
      insertText(text, span) {
        // Count ALL calls, not merely accepted writes, so a rejected stale write
        // cannot make the post-guard assertions pass accidentally.
        writesAttempted.push({ sessionId: id, text, span });
        return b.actions.insertText(text, span);
      },
      submit() { sendsAttempted.push(id); return b.actions.submit(); },
    } });
  }
  const owner = source('s1');
  const status = source(new Map([...sessions.keys()].map(id => [id, { pendingInteraction: undefined }])));
  const effects = [], errors = [];
  const ctx = {
    sessions: { binding: id => bindings.get(id) },
    conversation: {
      input: { for: scope => { assert.ok(facades.has(scope)); return facades.get(scope); } },
      blocks: { storeFor: id => sessions.get(id)?.block },
    },
    uiSession: { sessionStatus: status },
    slots: {
      register: (options, component) => core.register(options, component),
      inject(name, callback) {
        assert.equal(name, 'conversation.input.left');
        const disposers = [...callback()];
        return () => disposers.forEach(dispose => dispose());
      },
    },
    effect(callback) { effects.push(callback()); },
  };
  const host = {
    subscribe: (key, fn) => core.subscribe(key, fn),
    getVersion: key => core.getVersion(key),
    entriesOf: key => core.entries(key),
    entriesOfSlot: key => core.entriesOfSlot(key),
    specOf: key => core.specDynamic(key),
    isLive: entry => core.isLive(entry),
    storeOf: () => undefined,
    reportEntryError(key, entry, error, info) {
      errors.push({ key, error });
      core.reportEntryError(key, entry, error, info);
    },
  };
  const rootBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };

  function ConversationOwner() {
    const sessionId = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot);
    const b = sessions.get(sessionId);
    const session = React.useSyncExternalStore(b.session.subscribe, b.session.getSnapshot);
    const statuses = React.useSyncExternalStore(status.subscribe, status.getSnapshot);
    const input = React.useSyncExternalStore(b.input.subscribe, b.input.getSnapshot);
    const pendingInteraction = statuses.get(sessionId)?.pendingInteraction;
    return h(ScopeBindingContext.Provider, { value: bindings.get(sessionId) },
      h(SlotOutlet, {
        slotKey: 'conversation.composer',
        // Same owner props and overlay mode as rc.2 ConversationRoot.
        ownerProps: { sessionId, session, pendingInteraction },
        opts: {
          overlay: true,
          fallback: h('section', { 'data-native-composer': sessionId },
            h('textarea', { 'data-native-draft': sessionId, readOnly: true, value: input.draft }),
            h(SlotOutlet, { slotKey: 'conversation.input.left', ownerProps: { sessionId } })),
        },
      }));
  }

  const parent = document.createElement('div');
  document.body.append(parent);
  const root = ReactDOMClient.createRoot(parent);
  t.after(async () => {
    await act(async () => {
      root.unmount();
      effects.forEach(dispose => dispose());
      offRoot();
      await settle();
    });
    parent.remove();
    assert.deepEqual(errors, [], 'the actual renderer must not swallow entry crashes');
  });
  plugin.apply(ctx);
  const launcher = core.entriesOfSlot('conversation.input.left')[0];
  assert.ok(launcher, 'apply must register its real native launcher');
  const { manager } = launcher.inject('s1');
  await act(async () => {
    root.render(h(HostContext.Provider, { value: host },
      h(RootBindingContext.Provider, { value: rootBinding }, h(ConversationOwner))));
  });
  const native = parent.querySelector('[data-native-composer="s1"]');
  assert.ok(native);
  assert.equal(parent.querySelector('.cm-editor'), null);
  await act(async () => {
    parent.querySelector('.lmm-toggle').click();
    await settle();
  });
  const editorDOM = parent.querySelector('.cm-editor');
  assert.ok(editorDOM, 'the actual chain election must mount the bundled editor');
  const view = EditorView.findFromDOM(parent.querySelector('.cm-content'));
  assert.ok(view);
  const fallback = () => parent.querySelector('[data-chain-overlay-fallback="conversation.composer"]');
  assert.equal(fallback().style.display, 'none');
  assert.equal(parent.querySelector('[data-native-composer="s1"]'), native, 'overlay must retain the native subtree');
  assert.equal(manager.read('s1').active, true);
  return { b: sessions.get('s1'), second: sessions.get('s2'), parent, core, manager, owner, status,
    writesAttempted, sendsAttempted, editorDOM, view, native, fallback };
}

function assertSameEditor(f, stage) {
  assert.equal(f.parent.querySelector('.cm-editor'), f.editorDOM, `${stage}: preserve the same editor DOM`);
  assert.equal(f.editorDOM.isConnected, true, `${stage}: keep the editor mounted`);
  assert.equal(EditorView.findFromDOM(f.parent.querySelector('.cm-content')), f.view, `${stage}: preserve the editor instance`);
  assert.equal(f.manager.read('s1').active, true, `${stage}: keep the chain registration active`);
  assert.equal(f.fallback().style.display, 'none', `${stage}: do not reveal native early`);
}

function inputText(view, text, composing) {
  // jsdom has no native IME/contenteditable implementation. Apply the text with
  // CodeMirror's public transaction API and deliver the corresponding DOM input
  // event. Real editor listeners, guards, and the renderer handle the result;
  // no plugin callback or mirror method is invoked directly by this fixture.
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length }, userEvent: composing ? 'input.type.compose' : 'input.type' });
  view.contentDOM.dispatchEvent(new window.InputEvent('input', {
    bubbles: true, inputType: composing ? 'insertCompositionText' : 'insertText',
    isComposing: composing, data: composing ? 'ni' : '你',
  }));
}

async function startIME(f) {
  await act(async () => {
    f.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    inputText(f.view, 'hello ni', true);
    await settle();
  });
  assert.equal(f.view.state.doc.toString(), 'hello ni');
  assert.equal(f.b.readInput().draft, 'hello ni');
  assert.equal(f.manager.read('s1').recovery, '', 'the test must not start with an existing conflict copy');
  assertSameEditor(f, 'compositionstart');
}

for (const kind of ['running', 'pending interaction']) {
  test(`actual rc.2 renderer preserves IME through owner ${kind}, compositionend and late input`, integration, async t => {
    const f = await mount(t);
    await startIME(f);
    const writesBeforeGuard = f.writesAttempted.length;
    const hostBeforeGuard = f.b.readInput();
    await act(async () => {
      if (kind === 'running') f.b.session.set({ ...f.b.readSession(), running: true });
      else f.status.set(new Map([['s1', { pendingInteraction: { type: 'approval', id: 'pending-test' } }],
        ['s2', { pendingInteraction: undefined }]]));
      await settle();
    });
    assertSameEditor(f, `owner ${kind}`);
    assert.equal(f.writesAttempted.length, writesBeforeGuard);
    assert.equal(f.parent.querySelector('.lmm-send').disabled, true);

    // End first, then deliver the final candidate in a later event-loop turn.
    // No editor replacement/remount is acceptable in this settlement window.
    await act(async () => {
      f.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
      await settle();
    });
    assertSameEditor(f, 'compositionend before trailing input');
    await act(async () => {
      inputText(f.view, 'hello 你', false);
      await settle();
    });
    assertSameEditor(f, 'trailing input');
    assert.equal(f.view.state.doc.toString(), 'hello 你');
    assert.equal(f.manager.read('s1').recovery, 'hello 你');
    assert.equal(f.writesAttempted.length, writesBeforeGuard, 'a guard forbids even attempted host writes');
    assert.deepEqual(f.b.readInput(), hostBeforeGuard, 'do not mutate the protected host draft or revision');

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
    assert.equal(f.parent.querySelector('.cm-editor'), null, 'return to native after the IME settlement window');
    assert.equal(f.editorDOM.isConnected, false);
    assert.equal(f.manager.read('s1').active, false);
    assert.equal(f.core.entriesOfSlot('conversation.composer').length, 0);
    assert.equal(f.fallback().style.display, 'contents');
    assert.equal(f.parent.querySelector('[data-native-composer="s1"]'), f.native);
    assert.equal(f.parent.querySelector('.lmm-recovery textarea').value, 'hello 你');
    assert.equal(f.writesAttempted.length, writesBeforeGuard, 'handoff/unmount must not flush');
    assert.deepEqual(f.b.readInput(), hostBeforeGuard);
    assert.deepEqual(f.sendsAttempted, []);
  });
}

test('actual rc.2 renderer hard-unmounts on owner session switch and recovers the latest local IME text without a host write', integration, async t => {
  const f = await mount(t);
  await startIME(f);
  const writesBeforeSwitch = f.writesAttempted.length;
  const protectedHost = { ...f.b.readInput(), draft: 'external s1 draft', draftRev: f.b.readInput().draftRev + 1 };
  await act(async () => {
    // Switch in the same React batch as the external update: the old composer
    // cannot rely on another render/effect to capture its local buffer first.
    f.b.input.set(protectedHost);
    f.owner.set('s2');
    await settle();
  });
  assert.equal(f.editorDOM.isConnected, false, 'a different owner must not retain the old session editor');
  assert.equal(f.parent.querySelector('.cm-editor'), null);
  assert.equal(f.fallback().style.display, 'contents');
  assert.ok(f.parent.querySelector('[data-native-composer="s2"]'));
  assert.equal(f.manager.read('s1').active, false);
  assert.equal(f.manager.read('s1').recovery, 'hello ni', 'cleanup must preserve the latest local buffer, not the new host draft');
  assert.equal(f.manager.read('s2').recovery, '');
  assert.equal(f.writesAttempted.length, writesBeforeSwitch, 'session cleanup must never flush to either host');
  assert.deepEqual(f.b.readInput(), protectedHost);
  assert.equal(f.second.readInput().draft, 'second draft');

  await act(async () => { f.owner.set('s1'); await settle(); });
  assert.equal(f.parent.querySelector('.cm-editor'), null, 'returning to s1 does not silently re-enter');
  assert.equal(f.parent.querySelector('.lmm-recovery textarea').value, 'hello ni');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
  assert.equal(f.writesAttempted.length, writesBeforeSwitch, 'no delayed post-unmount write is allowed');
  assert.deepEqual(f.b.readInput(), protectedHost);
  assert.equal(f.second.readInput().draft, 'second draft');
  assert.deepEqual(f.sendsAttempted, []);
});
