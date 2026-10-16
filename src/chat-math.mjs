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
const CONVERSATION = '[data-chat-flow]';
// Anything code, editable, already rendered or already ours stays alone.
const SKIP = 'pre, code, [contenteditable="true"], .katex, .lmm-chat-formula';
const MAX_FORMULAS = 80;

/** Innermost text-carrying elements of the user messages that still need work. */
function candidates(doc) {
  const found = [];
  for (const message of doc.querySelectorAll(USER_MESSAGE)) {
    for (const element of message.querySelectorAll('*')) {
      if (element.firstElementChild) continue;
      // Already rendered here, or nothing that can be TeX.
      if (element.querySelector('.lmm-chat-formula')) continue;
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
  const nodes = [];
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
      nodes.push(wrapper);
      applied += 1;
    } else {
      nodes.push(doc.createTextNode(source));
    }
    at = span.to;
  }
  if (!applied) return 0;
  if (at < text.length) nodes.push(doc.createTextNode(text.slice(at)));
  element.replaceChildren(...nodes);
  element.setAttribute(CHAT_MATH_MARK, String(applied));
  return applied;
}

/**
 * Render every complete formula inside the sent user messages of one document.
 * @returns How many formulas were rendered in this pass.
 */
export function renderChatMath(doc) {
  let applied = 0;
  for (const element of candidates(doc)) {
    const text = element.textContent;
    const parsed = analyzeMarkdown(text);
    if (parsed.limited) continue;
    // Multi-line math stays source here exactly as it does in the composer.
    const spans = parsed.math.filter(span => !/[\r\n\uFFFC]/.test(text.slice(span.from, span.to)));
    if (!spans.length) continue;
    applied += replaceRun(doc, element, text, spans);
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
  const run = () => {
    if (stopped) return 0;
    try { return renderChatMath(doc); } catch { return 0; }   // display-only: never break the app
  };
  const schedule = () => {
    if (stopped || timer !== null) return;
    timer = win.setTimeout(() => { timer = null; run(); }, debounce);
  };
  run();
  if (typeof win.MutationObserver === 'function') {
    observer = new win.MutationObserver(schedule);
    const host = doc.querySelector(CONVERSATION) ?? doc.body;
    if (host) observer.observe(host, { childList: true, subtree: true, characterData: true });
  }
  return {
    run,
    schedule,
    dispose() {
      stopped = true;
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      observer?.disconnect();
      observer = null;
    },
  };
}
