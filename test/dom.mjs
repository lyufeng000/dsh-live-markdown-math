import { JSDOM } from 'jsdom';
export function setupDOM() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true, url: 'https://example.invalid/' });
  const { window } = dom;
  for (const key of ['window', 'Window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Text', 'Event', 'KeyboardEvent', 'CompositionEvent', 'MouseEvent', 'DOMRect', 'Range', 'getComputedStyle']) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
  }
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  const rect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 24, width: 800, height: 24 });
  window.Range.prototype.getBoundingClientRect = rect;
  window.Range.prototype.getClientRects = () => [rect()];
  window.HTMLElement.prototype.getBoundingClientRect = rect;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}
export async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }
export function source(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of listeners) fn(); },
  };
}
export function fakeBridge(text = '') {
  const input = source({ draft: text, draftRev: 0, phase: 'plain', occurrences: [], attachmentIds: [], queue: [] });
  const session = source({ sessionId: 's1', blank: false, awaitingFirstTurn: false, openState: 'open', removed: false, running: false, subagent: null });
  const block = source(undefined), pending = source(undefined);
  const writes = [], sends = [];
  let alive = true;
  const actions = {
    insertText(text, span) {
      const current = input.getSnapshot();
      if (span.draftRev !== current.draftRev || current.phase !== 'plain') return false;
      writes.push({ text, span });
      input.set({ ...current, draft: current.draft.slice(0, span.start) + text + current.draft.slice(span.end), draftRev: current.draftRev + 1 });
      return true;
    },
    submit() {
      const current = input.getSnapshot();
      sends.push(current.draft);
      input.set({ ...current, draft: '', draftRev: current.draftRev + 1 });
    },
  };
  return {
    input, session, block, pending, writes, sends,
    expire: () => { alive = false; },
    actions, alive: () => alive,
    readInput: input.getSnapshot, subscribeInput: input.subscribe,
    readSession: session.getSnapshot, subscribeSession: session.subscribe,
    readBlock: block.getSnapshot, subscribeBlock: block.subscribe,
    readPending: pending.getSnapshot, subscribePending: pending.subscribe,
  };
}
