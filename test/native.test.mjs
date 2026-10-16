import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDOM, settle } from './dom.mjs';
import { runtimePath, loadNativeRuntime, createFixture } from './native-runtime.mjs';
import { mountNativeAdapter, compatibleEditor } from '../src/native-adapter.mjs';
import { readLayout, selectionRange, makePlan, ownedStyle } from '../src/native-plan.mjs';
const dom = setupDOM();
const api = runtimePath ? loadNativeRuntime() : null;
after(() => dom.window.close());
const native = (name, fn) => test(name, { skip: !api && 'Set DSH_NATIVE_RUNTIME to reviewed extracted DSH rc.2 module' }, fn);
const tick = () => new Promise(resolve => setTimeout(resolve, 45));
const snapshot = f => f.editor.getEditorState().read(() => ({
  source: readLayout(api.getRoot()).text,
  range: selectionRange(api.getSelection(), readLayout(api.getRoot())),
  nodes: api.getRoot().getAllTextNodes().map(n => ({ key: n.getKey(), type: n.getType(), text: n.getTextContent(), style: n.getStyle(), format: n.getFormat() })),
}));
async function fixture(text = '', options = {}) {
  const f = createFixture(api, { text, ...options });
  const adapter = mountNativeAdapter(f.editor);
  await settle();
  return { ...f, adapter, dispose() { adapter.dispose(); f.dispose(); } };
}
function type(f, text) {
  for (const char of text) f.editor.update(() => {
    const root = api.getRoot(); if (!root.getChildrenSize()) root.append(api.createParagraph());
    root.selectEnd().insertText(char);
  }, { discrete: true });
}

native('real resident runtime keeps source, selection and stable split keys after repeated transforms', async () => {
  const source = '# 标题 **粗体** _斜体_ ~~删除~~ `x` $x^2$ 😀\n> 引用\n```js\nx++\n```';
  const f = await fixture(source);
  try {
    assert.equal(f.runtime.projection.clipboardText, source);
    assert.equal(snapshot(f).source, source);
    assert.deepEqual(snapshot(f).range, { from: source.length, to: source.length, anchor: source.length, focus: source.length });
    const before = snapshot(f);
    for (let i = 0; i < 10; i++) f.editor.update(() => api.getRoot().markDirty(), { discrete: true });
    assert.deepEqual(snapshot(f), before);
    await tick(); assert.equal(f.adapter.failed, false);
    assert.ok(f.root.querySelector('[data-lmm-hide]'));
    assert.equal(f.root.querySelector('.katex'), null, 'no KaTeX children in native editor');
    assert.equal(f.editor.getRootElement(), f.root);
  } finally { f.dispose(); }
});

for (const source of ['# ', '## 标题', '**加粗**', 'before _italic_ after', '~~delete~~', '`code`', '```js\nlet a=1\n```', '$x^2$', '$$\\frac{1}{2}$$', '\\(a+b\\)', '\\[x\\]', '$not closed', '\\$5.00 和 $6.00', '# **嵌套 _格式_**', 'a\n\n\nb', '😀 **中文** e\u0301', '<img src=x onerror=alert(1)>', '$$\na+b\n$$']) {
  native(`incremental native typing retains exact source: ${JSON.stringify(source)}`, async () => {
    const f = await fixture();
    try { type(f, source); assert.equal(f.runtime.projection.clipboardText, source); assert.equal(f.adapter.failed, false); }
    finally { f.dispose(); }
  });
}

native('native range mapping preserves backward and cross-line selection on mount', async () => {
  const f = createFixture(api, { text: '**first**\n第二行' });
  let adapter;
  try {
    f.editor.update(() => {
      const blocks = api.getRoot().getChildren();
      const selection = blocks[0].getFirstChild().select(1, 1);
      selection.anchor.set(blocks[1].getFirstChild().getKey(), 2, 'text');
    }, { discrete: true });
    const before = snapshot(f).range, projection = f.runtime.projection;
    adapter = mountNativeAdapter(f.editor); await settle();
    assert.deepEqual(snapshot(f).range, before); assert.deepEqual(f.runtime.projection.selection, projection.selection);
    assert.equal(f.editor.getEditorState().read(() => api.getSelection().isBackward()), true);
  } finally { adapter?.dispose(); f.dispose(); }
});

native('plain selection-only updates never mutate editor nodes or create formatting commits', async () => {
  const f = await fixture('**bold** and $x^2$'); let commits = 0;
  const off = f.editor.registerUpdateListener(() => commits++);
  try {
    const before = snapshot(f).nodes;
    f.editor.update(() => api.getRoot().getAllTextNodes().find(n => n.getTextContent() === 'bold').select(2, 2), { discrete: true });
    await tick(); assert.equal(commits, 1); assert.deepEqual(snapshot(f).nodes, before);
  } finally { off(); f.dispose(); }
});

native('native claim, text refs, reference chip identity and occurrences are preserved', async () => {
  const f = await fixture('/help **文字** @thing ', { claim: '/help ', lexicon: new Map([['@', ['thing']]]) });
  try {
    const nodes = snapshot(f).nodes;
    assert.equal(nodes[0].style, 'color: var(--dsw-alias-state-business-primary)');
    assert.ok(nodes.some(n => n.type === 'composer-text-ref' && n.text === '@thing' && !ownedStyle(n.style)));
    f.editor.update(() => api.getRoot().getLastChild().append(new api.ReferenceChipNode({ source: 'file', ref: 'fixture.md', label: 'fixture.md', clipboardText: '@fixture.md' })), { discrete: true });
    const before = f.runtime.projection;
    const key = f.editor.getEditorState().read(() => api.getRoot().getLastChild().getLastChild().getKey());
    f.editor.update(() => api.getRoot().markDirty(), { discrete: true });
    assert.equal(f.runtime.projection.clipboardText, '/help **文字** @thing @fixture.md');
    assert.equal(snapshot(f).source, f.runtime.projection.detectText);
    assert.deepEqual(f.runtime.projection.occurrences, before.occurrences);
    assert.equal(f.editor.getEditorState().read(() => api.getRoot().getLastChild().getLastChild().getKey()), key);
  } finally { f.dispose(); }
});

native('foreign inline styles and native format bits are not overwritten', async () => {
  const f = createFixture(api, { text: '**foreign**' }); let adapter;
  try {
    f.editor.update(() => { const n = api.getRoot().getFirstChild().getFirstChild(); n.setStyle('color: red'); n.setFormat(8); }, { discrete: true });
    const before = snapshot(f).nodes;
    adapter = mountNativeAdapter(f.editor); await settle();
    assert.deepEqual(snapshot(f).nodes, before);
    assert.equal(ownedStyle('--lmm-native: strong; color: red;'), false);
  } finally { adapter?.dispose(); f.dispose(); }
});

native('composition barrier prevents styling/splitting; settles without source replacement', async () => {
  const f = await fixture('');
  try {
    f.root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    type(f, '**中文**');
    assert.ok(snapshot(f).nodes.every(n => !ownedStyle(n.style)));
    assert.equal(f.root.querySelector('[data-lmm-hide]'), null);
    // This is a synthetic barrier test, not a Windows input-method acceptance test.
    f.root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.runtime.projection.clipboardText, '**中文**');
    assert.ok(snapshot(f).nodes.some(n => ownedStyle(n.style)));
    assert.equal(f.adapter.failed, false);
  } finally { f.dispose(); }
});

native('native undo/redo restores every source state; Markdown closure can split native grouping', async () => {
  const f = await fixture('');
  try {
    type(f, '**abc**');
    const states = [];
    for (let i = 0; i < 6; i++) {
      const before = f.runtime.projection.clipboardText;
      f.editor.dispatchCommand(api.undo, undefined); await settle();
      const after = f.runtime.projection.clipboardText;
      if (after === before) break;
      states.push(after);
    }
    assert.ok(states.includes('**abc*'), 'document known extra boundary at Markdown closure');
    assert.equal(states.at(-1), '');
    assert.equal(new Set(states).size, states.length, 'no source-identical cosmetic undo steps');
    for (let i = 0; i < states.length; i++) { f.editor.dispatchCommand(api.redo, undefined); await settle(); }
    assert.equal(f.runtime.projection.clipboardText, '**abc**');
  } finally { f.dispose(); }
});

native('native paste command and file/drop events are not intercepted', async () => {
  const f = await fixture('**before** '); let called = 0;
  const off = f.editor.registerCommand(api.paste, payload => {
    called++; assert.equal(payload.files[0].type, 'image/png');
    f.runtime.paste(payload.text); return true;
  }, 4);
  try {
    assert.equal(f.editor.dispatchCommand(api.paste, { files: [{ type: 'image/png' }], text: '$x$ ' }), true);
    await settle(); type(f, '**after**');
    assert.equal(called, 1); assert.equal(f.runtime.projection.clipboardText, '**before** $x$ **after**');
    let drops = 0; const onDrop = () => drops++; f.root.addEventListener('drop', onDrop);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [], types: [], getData: () => '' } });
    f.root.dispatchEvent(drop);
    assert.equal(drops, 1); assert.equal(drop.defaultPrevented, false); f.root.removeEventListener('drop', onDrop);
    // The handler above is a file-ingest seam, not a real attachment upload.
  } finally { off(); f.dispose(); }
});

native('native copy exports source and harmless metadata, never visual hiding CSS', async () => {
  const f = await fixture('**bold** $x^2$');
  try {
    const copied = f.editor.getEditorState().read(() => {
      const root = api.getRoot();
      return root.getAllTextNodes().map(n => n.exportJSON());
    });
    assert.equal(copied.map(n => n.text).join(''), '**bold** $x^2$');
    assert.ok(copied.every(n => !/font-size|display:|width:/.test(n.style)));
    f.editor.update(() => {
      const nodes = api.getRoot().getAllTextNodes();
      const selection = nodes[0].select(0, 0);
      selection.focus.set(nodes.at(-1).getKey(), nodes.at(-1).getTextContentSize(), 'text');
    }, { discrete: true });
    const clipboard = new Map();
    f.editor.dispatchCommand(api.copy, { preventDefault() {}, clipboardData: { setData: (type, value) => clipboard.set(type, value) } });
    await settle();
    assert.equal(clipboard.get('text/plain'), '**bold** $x^2$');
    assert.ok(!/font-size: ?0|data-lmm-hide|data-lmm-math|lmm-width/.test(clipboard.get('text/html')));
  } finally { f.dispose(); }
});

native('dispose restores plain native view without changing draft, root, selection or history', async () => {
  const f = await fixture('**bold** $x^2$');
  try {
    await tick(); const before = snapshot(f), state = f.editor.getEditorState();
    f.adapter.dispose(); await tick();
    assert.equal(f.editor.getEditorState(), state); assert.deepEqual(snapshot(f), before);
    assert.equal(f.editor.getRootElement(), f.root); assert.equal(f.root.hasAttribute('data-lmm-native'), false);
    assert.equal(document.querySelector('.lmm-native-layer'), null);
    assert.equal(f.root.querySelector('[data-lmm-role]'), null);
    type(f, '继续'); assert.equal(f.runtime.projection.clipboardText, '**bold** $x^2$继续');
  } finally { f.dispose(); }
});

native('simple formula clicks choose an interior native caret without rewriting source', async () => {
  const source = '公式 $x^2$ 后', f = await fixture(source);
  try {
    // Synthetic geometry exercises event policy only; Chrome checks real layout.
    f.root.getBoundingClientRect = () => new DOMRect(0, 0, 1600, 24);
    f.adapter.refresh(); await tick();
    const target = f.root.querySelector('[data-lmm-math]'); assert.ok(target);
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 400 }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: 400, detail: 1 }));
    await tick();
    const { range } = snapshot(f);
    assert.equal(range.from, range.to); assert.ok(range.from > 3 && range.from < 8);
    assert.equal(f.runtime.projection.clipboardText, source);
    assert.equal(f.root.querySelector('[data-lmm-math]'), null);
  } finally { f.dispose(); }
});

for (const mode of ['shift', 'drag', 'double', 'unmount']) {
  native(`formula click correction does not take over ${mode} selection`, async () => {
    const f = await fixture('公式 $x^2$ 后');
    try {
      // Synthetic geometry exercises event policy only; Chrome checks real layout.
      f.root.getBoundingClientRect = () => new DOMRect(0, 0, 1600, 24);
      f.adapter.refresh(); await tick();
      const target = f.root.querySelector('[data-lmm-math]'); assert.ok(target);
      const before = snapshot(f);
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 400, shiftKey: mode === 'shift' }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: mode === 'drag' ? 410 : 400, detail: mode === 'double' ? 2 : 1, shiftKey: mode === 'shift' }));
      if (mode === 'unmount') f.adapter.dispose();
      await tick();
      assert.deepEqual(snapshot(f), before);
    } finally { f.dispose(); }
  });
}

native('oversized and fragmented drafts fail open to readable native source', async () => {
  const f = await fixture('a'.repeat(100001));
  try {
    assert.equal(snapshot(f).source.length, 100001); assert.equal(f.adapter.failed, false);
    assert.equal(makePlan('a'.repeat(100001)).limited, true);
    assert.equal(compatibleEditor({}), false);
  } finally { f.dispose(); }
});

const roles = plan => [...new Set(plan.segments.flatMap(s => s.roles.map(r => r.replace(/-\d+$/, ''))))];
native('composition keeps the rendered view instead of snapping back to source', async () => {
  const f = await fixture('# 标题');
  try {
    await tick();
    const hidden = () => f.root.querySelectorAll('[data-lmm-hide]').length;
    assert.equal(hidden(), 1, 'the heading marker starts hidden');
    f.root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await tick();
    // Regression: compositionstart used to clear the whole view, so a rendered
    // line reverted to raw source for the duration of every IME composition.
    assert.equal(hidden(), 1, 'composition must not reveal hidden source');
    assert.ok(f.root.hasAttribute('data-lmm-composing'));
    // The transform stays paused (see the composition-barrier case); what matters
    // here is that the already-rendered nodes keep their styles and hidden markers.
    assert.ok(snapshot(f).nodes.some(n => ownedStyle(n.style)), 'existing styles are kept during composition');
    f.root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(hidden(), 1, 'the view is still rendered after composition settles');
    assert.equal(f.runtime.projection.clipboardText, '# 标题');
    assert.equal(f.adapter.failed, false);
  } finally { f.dispose(); }
});

native('a composition that never reports its end cannot freeze the view', async () => {
  const f = await fixture('');
  try {
    type(f, '# 标题'); await tick();
    assert.equal(f.root.querySelectorAll('[data-lmm-hide]').length, 1);
    // An IME dismissed on focus loss can leave compositionstart without its end.
    f.root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await tick();
    assert.ok(f.root.hasAttribute('data-lmm-composing'));
    type(f, ' 更多'); await tick();
    assert.equal(f.root.querySelectorAll('[data-lmm-hide]').length, 1, 'composition keeps the earlier view');
    f.root.dispatchEvent(new Event('blur'));
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(f.root.hasAttribute('data-lmm-composing'), false, 'focus loss ends the composition');
    assert.equal(f.runtime.projection.clipboardText, '# 标题 更多');
    assert.equal(f.adapter.failed, false);
  } finally { f.dispose(); }
});

native('standard list syntax is recognised and keeps its source', async () => {
  // A marker only becomes a list once its own space is typed, exactly like '#'.
  for (const text of ['-', '*', '+', '1.', '12.', '1.5', '1.打']) {
    const plan = makePlan(text);
    assert.equal(plan.markers.length, 0, `${text} must stay plain source before the space`);
    assert.ok(!plan.segments.some(segment => segment.roles.some(role => /^(u|o)lm$/.test(role))), `${text} must not gain a list role`);
  }
  for (const [text, role] of [['- item', 'ulm'], ['* item', 'ulm'], ['1. item', 'olm'], ['12. item', 'olm']]) {
    const plan = makePlan(text);
    assert.equal(plan.markers.length, 1, `${text} must hide one list marker`);
    assert.ok(plan.segments.some(segment => segment.roles.includes(role)), `${text} must carry the ${role} role`);
  }
  const f = await fixture('');
  try {
    type(f, '- 第一项'); await tick();
    const marker = f.root.querySelector('[data-lmm-hide]');
    assert.ok(marker, 'a bullet marker is hidden');
    assert.equal(marker.getAttribute('data-lmm-role'), 'ulm');
    assert.equal(f.runtime.projection.clipboardText, '- 第一项');
    // Enter already continues the list, so the next item only needs its text.
    type(f, '\n第二项'); await tick();
    assert.equal(f.runtime.projection.clipboardText, '- 第一项\n- 第二项');
    type(f, '\n\n1. 第三项'); await tick();
    const ordered = [...f.root.querySelectorAll('[data-lmm-role~="olm"]')];
    assert.equal(ordered.length, 1, 'one ordered marker');
    assert.equal(ordered[0].style.getPropertyValue('--lmm-list-label'), '"1."');
    assert.equal(ordered[0].getAttribute('data-lmm-hide'), 'true');
    assert.equal(f.runtime.projection.clipboardText, '- 第一项\n- 第二项\n1. 第三项');
    assert.equal(f.adapter.failed, false);
  } finally { f.dispose(); }
});

native('hidden syntax collects no spell-check markers', async () => {
  const f = await fixture('# 标题');
  try {
    await tick();
    // Regression: squeezed hidden source kept collecting spell-check squiggles,
    // which bunched into a red pile over the rendered formula.
    const marker = f.root.querySelector('[data-lmm-hide]');
    assert.ok(marker, 'the heading marker is hidden');
    assert.equal(marker.getAttribute('spellcheck'), 'false', 'hidden source must not be spell-checked');
    assert.equal(f.adapter.failed, false);
  } finally { f.dispose(); }
});
native('space-delimited block syntax stays source until its space is typed', async () => {
  // Same rule as '#': a bare marker mid-type must never collapse or be swallowed.
  for (const text of ['>', '>引用', '```', '```js', '```js\ncode']) {
    const plan = makePlan(text);
    assert.equal(plan.markers.length, 0, `${text} must stay plain source`);
  }
  for (const [text, roles] of [['> 引用', ['quote']], ['```js\ncode\n```', ['codeblock']]]) {
    const plan = makePlan(text);
    assert.ok(plan.markers.length >= 1, `${text} must hide its marker once complete`);
    for (const role of roles) assert.ok(plan.segments.some(segment => segment.roles.includes(role)), `${text} must carry ${role}`);
  }
});

native('Enter continues a list and an empty item ends it', async () => {
  const f = await fixture('1. 内容');
  try {
    type(f, '\n'); await tick();
    assert.equal(f.runtime.projection.clipboardText, '1. 内容\n2. ', 'the new line continues the numbering');
    type(f, '\n'); await tick();
    assert.equal(f.runtime.projection.clipboardText, '1. 内容\n', 'Enter on the empty item drops its marker');
    assert.equal(f.adapter.failed, false);
  } finally { f.dispose(); }
  const bullets = await fixture('- 项目');
  try {
    type(bullets, '\n'); await tick();
    assert.equal(bullets.runtime.projection.clipboardText, '- 项目\n- ');
  } finally { bullets.dispose(); }
  const plain = await fixture('普通文本');
  try {
    type(plain, '\n'); await tick();
    assert.equal(plain.runtime.projection.clipboardText, '普通文本\n', 'plain paragraphs are never numbered');
  } finally { plain.dispose(); }
});

native('an unconfirmed hash line stays visible until the heading space is typed', async () => {
  // Typing '#include', '#tag' or '#1' must never hide the leading hash mid-word.
  // The parser itself also refuses a tab and a non-breaking space, which is the
  // same conclusion reached from the other side.
  for (const text of ['#', '##', '###', '#\t', '#include']) {
    const plan = makePlan(text);
    assert.equal(plan.markers.length, 0, `${text} must stay plain source`);
    assert.deepEqual(roles(plan), [], `${text} must not gain a heading role`);
  }
  for (const text of ['# ', '# 标题', '## 标题', '### 标题 ###']) {
    const plan = makePlan(text);
    assert.ok(plan.markers.length >= 1, `${text} must hide its heading marker`);
    assert.ok(roles(plan).some(role => /^h[1-6]$/.test(role)), `${text} must gain a heading role`);
  }
  // The transient states while typing a heading never touch the draft itself.
  const f = await fixture('');
  try {
    type(f, '#'); await tick();
    assert.equal(snapshot(f).source, '#');
    assert.deepEqual(f.root.querySelectorAll('[data-lmm-hide]').length, 0);
    type(f, ' '); await tick();
    assert.equal(snapshot(f).source, '# ');
    assert.equal(f.root.querySelectorAll('[data-lmm-hide]').length, 1);
  } finally { f.dispose(); }
});
