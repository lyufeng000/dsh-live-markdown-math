// Runs only in a new isolated Chrome profile; never in the user's DSH page.
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { mountNativeAdapter } from '../src/native-adapter.mjs';
import { readLayout, selectionRange } from '../src/native-plan.mjs';
window.React = React;
window.createNativeProbe = factory => {
  const api = factory(jsx, React), errors = [];
  let runtime;
  runtime = new api.DraftEditorRuntime({ openReference() {}, activeClaimToken: () => null, lexicon: () => new Map(), resolveLexicon: () => undefined, onUpdate: () => runtime.refreshProjection() });
  const editor = runtime.editor; editor._onError = error => errors.push(error.message);
  const off = runtime.register();
  const scroll = document.querySelector('[data-input-scroll]'), root = document.querySelector('#editor');
  editor.setRootElement(root); root.focus();
  const adapter = mountNativeAdapter(editor);
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  const project = () => editor.getEditorState().read(() => ({ text: runtime.projection.clipboardText, range: selectionRange(api.getSelection(), readLayout(api.getRoot())) }));
  const select = (from, to = from) => editor.update(() => {
    const layout = readLayout(api.getRoot());
    const point = at => {
      const leaf = layout.leaves.find(n => at >= n.from && at <= n.to);
      if (!leaf) throw new Error(`no leaf for ${at}`);
      return { key: leaf.key, offset: at - leaf.from };
    };
    const a = point(from), b = point(to), selection = api.getRoot().selectStart();
    selection.anchor.set(a.key, a.offset, 'text'); selection.focus.set(b.key, b.offset, 'text');
  }, { discrete: true });
  return window.probe = {
    api, runtime, editor, root, scroll, adapter, errors, wait, select, project,
    async set(text, caret) { root.focus(); runtime.setDraft(text); if (caret !== undefined) select(caret); await wait(); return project(); },
    caret() {
      const selection = getSelection();
      if (!selection?.rangeCount) return null;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      return { height: rect.height, width: rect.width, left: rect.left, right: rect.right, top: rect.top };
    },
    snapshot() {
      const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      return { ...project(), failed: adapter.failed, errors, scrollTop: scroll.scrollTop, maxScroll: scroll.scrollHeight - scroll.clientHeight, scroll: rect(scroll), root: rect(root),
        formulas: [...document.querySelectorAll('.lmm-native-formula')].map(e => ({ rect: rect(e), clip: getComputedStyle(e).clipPath, text: e.textContent })),
        placeholders: [...root.querySelectorAll('[data-lmm-math]')].map(e => ({ rect: rect(e), source: e.textContent })),
        markers: [...root.querySelectorAll('[data-lmm-hide]')].map(e => ({ rect: rect(e), source: e.textContent })),
      };
    },
    dispose() { adapter.dispose(); off(); },
  };
};
