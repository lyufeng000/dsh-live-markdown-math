import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDOM } from './dom.mjs';
import { renderChatMath, createChatMath, CHAT_MATH_MARK } from '../src/chat-math.mjs';

/** One document shaped like the live conversation: a user bubble and an assistant step. */
function build(text) {
  const dom = setupDOM(), doc = dom.window.document;
  doc.body.innerHTML = '<div data-chat-flow="">'
    + '<div data-chat-flow-kind="user" data-chat-node-key="13:input-message1">'
    + '<div data-slot="conversation.chat.node"><div class="bubble"><span class="plainRun"></span></div></div></div>'
    + '<div data-chat-flow-kind="assistant-step">'
    + '<div data-slot="conversation.chat.node"><div class="markdown"><p><code>$x$</code></p></div></div></div>'
    + '</div>';
  const user = doc.querySelector('[data-chat-flow-kind="user"]');
  user.querySelector('.plainRun').textContent = text;
  return {dom, doc, user, run: user.querySelector('.plainRun'), assistant: doc.querySelector('[data-chat-flow-kind="assistant-step"]')};
}

test('a sent user message renders its formula without touching anything else', () => {
  const {dom, doc, user, run} = build('测试 $\\frac{1}{2}$ 结束');
  assert.equal(renderChatMath(doc), 1);
  const formula = user.querySelector('.lmm-chat-formula');
  assert.ok(formula, 'the formula is rendered');
  assert.ok(formula.querySelector('.katex'), 'through KaTeX');
  // Copy fidelity: the source run stays in the DOM and the rendered markup is
  // excluded from selection, so selecting the message yields what was typed.
  assert.equal(formula.querySelector('.lmm-chat-source').textContent, '$\\frac{1}{2}$');
  assert.equal(formula.querySelector('.katex').style.userSelect, 'none');
  assert.ok(run.hasAttribute(CHAT_MATH_MARK));
  assert.equal(user.textContent.includes('结束'), true, 'the surrounding text survives');
  assert.equal(formula.previousSibling.textContent, '测试 ');
  assert.equal(renderChatMath(doc), 0, 'a second pass finds nothing to do');
  dom.window.close();
});

test('assistant markdown is never touched', () => {
  const {dom, doc, assistant} = build('nothing here');
  renderChatMath(doc);
  assert.equal(assistant.querySelector('code').textContent, '$x$');
  assert.equal(assistant.querySelector('.lmm-chat-formula'), null);
  dom.window.close();
});

test('incomplete or non-math dollar signs stay exactly as typed', () => {
  for (const text of ['价格是 $5 和 $6', '$\\frac{1}{2}', 'costs $HOME now', 'no math here']) {
    const {dom, doc, run} = build(text);
    assert.equal(renderChatMath(doc), 0, 'nothing renders for: ' + text);
    assert.equal(run.textContent, text);
    dom.window.close();
  }
});

test('rendering is idempotent and repairs a repaint', async () => {
  const {dom, doc, user, run} = build('公式 $x^2$ 后');
  assert.equal(renderChatMath(doc), 1);
  assert.ok(run.hasAttribute(CHAT_MATH_MARK));
  // The app repaints the bubble with the raw text: our marker goes with it.
  run.replaceChildren(doc.createTextNode('公式 $x^2$ 后'));
  assert.equal(renderChatMath(doc), 1, 'repaired right away');
  run.replaceChildren(doc.createTextNode('公式 $x^2$ 后'));
  const watcher = createChatMath(doc, {debounce: 10});
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(user.querySelectorAll('.lmm-chat-formula').length, 1, 'repaired after a repaint');
  watcher.dispose();
  assert.doesNotThrow(() => watcher.run());
  dom.window.close();
});

test('display-only rendering never throws on hostile text and injects no markup', () => {
  const {dom, doc, run} = build('');
  run.textContent = '$$$$$ $\\frac{$ <img src=x onerror=alert(1)> $a$';
  assert.doesNotThrow(() => renderChatMath(doc));
  assert.equal(doc.querySelectorAll('img').length, 0, 'no markup from the message is executed');
  assert.equal(doc.querySelectorAll('script').length, 0);
  dom.window.close();
});
