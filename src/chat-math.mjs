/**
 * View-only TeX rendering for sent user messages.
 *
 * DSH renders a user turn as a plain run of text (`[data-chat-flow-kind="user"]`),
 * so a formula the composer renders happily is shown verbatim once it is sent.
 * This module re-renders those formulas in place, at the display layer only: the
 * message data, the submit path and every other part of the shipped bubble stay
 * untouched, and the source text stays in the DOM (invisible, still selectable,
 * with the rendered markup excluded from selection) so selecting or copying a
 * message still yields what the user actually typed.
 *
 * The grammar is the composer's own, so what renders while typing is what renders
 * after sending. Repairs after an app repaint are idempotent: an element that
 * already holds our wrapper is skipped until the app replaces it.
 */
import { analyzeMarkdown } from './markdown.mjs';
import { renderFormula } from './math.mjs';

export const CHAT_MATH_MARK = 'data-lmm-chat-math';
const USER_MESSAGE = '[data-chat-flow-kind="user"]';
// DSH projectUserText owns a CSS-module plainRun span with one string child.
// Fail open if that private display seam changes; never search arbitrary labels.
const SKIP = 'pre, code, [contenteditable], [data-ref-chip], [data-message-attachments], button, a, [role="button"], .katex, .lmm-chat-formula';
const MAX_FORMULAS = 80;
const documents = new WeakMap();
const recordsFor = doc => {
  let records = documents.get(doc);
  if (!records) { records = new Map(); documents.set(doc, records); }
  return records;
};
const intact = (element, record) => element.childNodes.length === record.rendered.length &&
  record.rendered.every((node, i) => element.childNodes[i] === node &&
    (node.nodeType !== 3 || node.data === record.texts[i]));
function restoreRun(element, record) {
  // Reuse the original native Text node. Never restore stale text over a newer
  // React repaint; partial foreign changes only get our own wrappers unwrapped.
  if (intact(element, record)) element.replaceChildren(...record.original);
  else for (const [wrapper, source] of record.formulas) {
    if (wrapper.parentNode === element) wrapper.replaceWith(element.ownerDocument.createTextNode(source));
  }
  element.removeAttribute(CHAT_MATH_MARK);
}

/** Innermost text-carrying elements of the user messages that still need work. */
function candidates(doc) {
  const found = [];
  for (const message of doc.querySelectorAll(USER_MESSAGE)) {
    for (const element of message.querySelectorAll('span[class]')) {
      // Reviewed production CSS: ._plainRun_fbulu_6 (CSS-module name/hash/line).
      if (![...element.classList].some(name => name === 'plainRun' || /^_plainRun_[a-zA-Z0-9]+_\d+$/.test(name))) continue;
      if (element.childNodes.length !== 1 || element.firstChild.nodeType !== 3) continue;
      // Only the native one-string-child contract is safe for React repainting.
      const text = element.textContent;
      if (!text.includes('$') && !text.includes('\\')) continue;
      if (element.closest(SKIP)) continue;
      found.push(element);
    }
  }
  return found;
}

/**
 * Replace every complete math span of one run with its rendered form.
 * @returns How many formulas this run produced.
 */
function replaceRun(doc, element, text, spans) {
  const nodes = [], formulas = new Map();
  let at = 0, applied = 0;
  for (const span of spans) {
    if (span.from > at) nodes.push(doc.createTextNode(text.slice(at, span.from)));
    const source = text.slice(span.from, span.to);
    const rendered = renderFormula(doc, span.tex ?? source.replace(/^\$+|\$+$/g, ''), Boolean(span.display));
    if (rendered.dataset.valid === 'true') {
      const wrapper = doc.createElement('span');
      wrapper.className = 'lmm-chat-formula';
      const hidden = doc.createElement('span');
      hidden.className = 'lmm-chat-source';
      hidden.textContent = source;
      hidden.setAttribute('aria-hidden', 'false');
      // The rendered markup is decoration: selection and copying must yield the
      // source run, never KaTeX's own HTML and MathML text.
      for (const node of [rendered, rendered.querySelector('.katex')]) {
        if (!node) continue;
        node.style.userSelect = 'none';
        node.style.pointerEvents = 'none';
      }
      wrapper.append(hidden, rendered);
      nodes.push(wrapper); formulas.set(wrapper, source);
      applied += 1;
    } else {
      nodes.push(doc.createTextNode(source));
    }
    at = span.to;
  }
  if (!applied) return 0;
  if (at < text.length) nodes.push(doc.createTextNode(text.slice(at)));
  const original = [...element.childNodes];
  element.replaceChildren(...nodes);
  recordsFor(doc).set(element, { original, rendered: nodes, texts: nodes.map(node => node.nodeType === 3 ? node.data : null), formulas });
  element.setAttribute(CHAT_MATH_MARK, String(applied));
  return applied;
}

/**
 * Render every complete formula inside the sent user messages of one document.
 * @returns How many formulas were rendered in this pass.
 */
export function renderChatMath(doc) {
  const records = recordsFor(doc);
  for (const [element, record] of records) {
    if (!element.isConnected || !intact(element, record)) {
      restoreRun(element, record); records.delete(element);
    }
  }
  let applied = 0;
  for (const element of candidates(doc)) {
    const text = element.textContent;
    const parsed = analyzeMarkdown(text);
    if (parsed.limited) continue;
    // Multi-line math stays source here exactly as it does in the composer.
    const spans = parsed.math.filter(span => !/[\r\n\uFFFC]/.test(text.slice(span.from, span.to)));
    if (!spans.length) continue;
    applied += replaceRun(doc, element, text, spans.slice(0, MAX_FORMULAS - applied));
    if (applied >= MAX_FORMULAS) break;
  }
  return applied;
}

/**
 * Keep sent messages rendered for the life of the plugin: scan once, then repair
 * after every repaint the conversation performs.
 */
export function createChatMath(doc, { debounce = 150 } = {}) {
  const win = doc.defaultView;
  let timer = null, observer = null, stopped = false;
  const observe = () => {
    if (!stopped && doc.body) observer?.observe(doc.body, { childList: true, subtree: true, characterData: true });
  };
  const run = () => {
    if (stopped) return 0;
    observer?.disconnect(); // our own KaTeX writes must not schedule another scan
    try { return renderChatMath(doc); } catch { return 0; }   // display-only: never break the app
    finally { observe(); }
  };
  const schedule = () => {
    if (stopped || timer !== null) return;
    timer = win.setTimeout(() => { timer = null; run(); }, debounce);
  };
  if (typeof win.MutationObserver === 'function') {
    observer = new win.MutationObserver(mutations => {
      const hasMessage = node => node.nodeType === 1 && (node.matches(USER_MESSAGE) || node.querySelector(USER_MESSAGE));
      if (mutations.some(mutation => {
        const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        return target?.closest(USER_MESSAGE) || [...mutation.addedNodes, ...mutation.removedNodes].some(hasMessage);
      })) schedule();
    });
  }
  // Observe the resident body, not the first replaceable session flow.
  run();
  return {
    run,
    schedule,
    dispose() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      observer?.disconnect();
      observer = null;
      const records = recordsFor(doc);
      for (const [element, record] of records) restoreRun(element, record);
      records.clear();
    },
  };
}
