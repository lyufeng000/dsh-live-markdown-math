import React from 'react';
import { compatibleEditor, mountNativeAdapter, ADAPTER_REVISION } from './native-adapter.mjs';
import css from './native.css';
import katexCss from 'katex/dist/katex.min.css';
import { createChatMath } from './chat-math.mjs';

export const name = 'live-markdown-math';
export const inject = ['slots', 'conversation', 'sessions'];
export const revision = ADAPTER_REVISION;

/** Explicitly version-bound private seam. Never construct another editor. */
export function nativeEditor(ctx, sessionId) {
  try {
    const binding = ctx.sessions.binding(sessionId);
    if (!binding?.ctx) return null;
    const editor = ctx.conversation.input.for(binding.ctx)?.editor;
    return compatibleEditor(editor) ? editor : null;
  } catch { return null; }
}

export function createManager({ onError = () => {} } = {}) {
  const active = new Map(); let disposed = false, warned = false;
  // A structural match that later fails must be visible once, without turning a
  // broken adapter into a console flood while several sessions mount.
  const report = message => {
    if (warned) return;
    warned = true;
    try { onError(message); } catch { /* diagnostics must not break the composer */ }
  };
  return {
    acquire(editor) {
      if (!editor || disposed) return () => {};
      let entry = active.get(editor);
      if (!entry) {
        const adapter = mountNativeAdapter(editor, { onError: report });
        if (!adapter) return () => {};
        entry = { adapter, refs: 0 }; active.set(editor, entry);
      }
      entry.refs++;
      let released = false;
      return () => {
        if (released) return; released = true;
        if (--entry.refs === 0) { entry.adapter.dispose(); active.delete(editor); }
      };
    },
    dispose() {
      disposed = true;
      for (const entry of active.values()) entry.adapter.dispose();
      active.clear();
    },
  };
}

/** Lifecycle only: renders no control, toolbar, alternate editor or preview pane. */
export function NativeEnhancement({ editor, manager }) {
  React.useLayoutEffect(() => manager.acquire(editor), [editor, manager]);
  return null;
}

export function apply(ctx) {
  // A hot-reloaded client half can leave the previous instance's stylesheet,
  // overlay layer, listeners and adapters behind. Several live adapters both
  // overlay stale formulas and fight over the caret, so take over first: ask the
  // previous instance to dispose itself, then clear any trace it left.
  try { globalThis.__lmmNativeDispose?.(); } catch { /* a broken older instance must not block this one */ }
  for (const stale of document.querySelectorAll('style[data-plugin="dsh-live-markdown-math"]')) stale.remove();
  for (const stale of document.querySelectorAll('.lmm-native-layer')) stale.remove();
  for (const stale of document.querySelectorAll('[data-lmm-native],[data-lmm-composing]')) {
    stale.removeAttribute('data-lmm-native'); stale.removeAttribute('data-lmm-composing');
  }
  const style = document.createElement('style');
  style.dataset.plugin = 'dsh-live-markdown-math'; style.dataset.revision = revision;
  style.textContent = `${katexCss}\n${css}`; document.head.append(style);
  const manager = createManager({
    onError: message => {
      try { console.warn(`[dsh-live-markdown-math] native adapter disabled: ${message}`); } catch { /* no console */ }
    },
  });

  // Sent user messages get the same TeX rendering the composer shows, view-only.
  const chat = createChatMath(document);
  const off = ctx.slots.inject('conversation.input.overlay', function* () {
    yield ctx.slots.register({
      name: 'conversation.input.overlay', id: 'live-markdown-math-native', priority: 90,
      inject: sessionId => ({ editor: nativeEditor(ctx, sessionId), manager }),
    }, NativeEnhancement);
  });
  const dispose = () => {
    chat.dispose(); manager.dispose(); off?.(); style.remove();
    if (globalThis.__lmmNativeDispose === dispose) delete globalThis.__lmmNativeDispose;
  };
  globalThis.__lmmNativeDispose = dispose;
  ctx.effect(() => dispose);
}
