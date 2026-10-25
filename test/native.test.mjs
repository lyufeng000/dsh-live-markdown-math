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
// Newline continuation must be driven by the resident native keymap, not an
// arbitrary programmatic insert (paste/draft restore also use that path).
const newline = f => f.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
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
    assert.equal(nodes[0].style, '', '0.2.1 no longer styles the claimed token as a TextNode');
    assert.ok(nodes.some(n => n.type === 'composer-text-ref' && n.text === '@thing' && !ownedStyle(n.style)));
    // 0.2.1 represents a claimed command as an atomic CommandChipNode instead of
    // a styled leading TextNode. Insert the chip the same way the shell does.
    const claim = { token: '/help ', name: 'help', submit() {} };
    f.editor.update(() => {
      const first = api.getRoot().getFirstChild().getFirstChild();
      assert.equal(first.getTextContent(), '/help ');
      const chip = new api.CommandChipNode(claim);
      first.replace(chip);
      chip.insertAfter(api.createText(' '));
    }, { discrete: true });
    const types = f.editor.getEditorState().read(() => {
      const found = [];
      const walk = node => {
        found.push(node.getType());
        if (typeof node.getChildren === 'function') for (const child of node.getChildren()) walk(child);
      };
      walk(api.getRoot());
      return found;
    });
    assert.ok(types.includes('command-chip'), 'the claim is an atomic command chip');
    assert.equal(f.runtime.projection.command?.token, '/help ', 'the projection exposes the command claim');
    assert.equal(f.runtime.projection.clipboardText, '/help **文字** @thing ');
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
  for (const text of ['-', '*', '+', '1.5', '1.打']) {
    const plan = makePlan(text);
    assert.equal(plan.markers.length, 0, `${text} must stay plain source before the space`);
    assert.ok(!plan.segments.some(segment => segment.roles.some(role => /^(u|o)lm$/.test(role))), `${text} must not gain a list role`);
  }
  for (const [text, role] of [['- item', 'ulm'], ['* item', 'ulm'], ['1. item', 'olm'], ['12. item', 'olm'], ['1.', 'olm'], ['12.', 'olm'], ['给网页做一个功能：\n1.', 'olm'], ['给网页做一个功能：\n1. ', 'olm']]) {
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
    newline(f); await tick(); type(f, '第二项'); await tick();
    assert.equal(f.runtime.projection.clipboardText, '- 第一项\n- 第二项');
    newline(f); await tick(); newline(f); await tick(); type(f, '1. 第三项'); await tick();
    const ordered = [...f.root.querySelectorAll('[data-lmm-role~="olm"]')];
    assert.equal(ordered.length, 1, 'one ordered marker');
    assert.equal(ordered[0].style.getPropertyValue('--lmm-list-label'), '"1."');
    assert.equal(ordered[0].getAttribute('data-lmm-hide'), 'true');
    assert.equal(f.runtime.projection.clipboardText, '- 第一项\n- 第二项\n1. 第三项');
    assert.equal(f.adapter.failed, false);
  } finally { f.dispose(); }
});

test('list plans expose only confirmed markers, including delimiters and whitespace variants', () => {
  for (const text of ['-\t内容', '1.\t内容', '1) 内容', '  - 内容', '- a\n\t- b', '> - 内容', '- - 内容']) {
    const plan = makePlan(text);
    assert.ok(plan.lists.length, `${JSON.stringify(text)} has a confirmed list marker`);
    for (const item of plan.lists) {
      assert.match(text.slice(item.from, item.to), /^(?:[-*+]|\d{1,9}[.)])$/);
      assert.ok(plan.segments.some(segment => segment.from === item.from && segment.roles.some(role => role === 'ulm' || role === 'olm')));
    }
  }
  for (const text of ['-', '+', '*', '1)word', '1.5', '    1)', '\t- code', '```\n1)\n```', '<div>\n1)\n</div>', '$$\n1)\n$$']) {
    assert.equal(makePlan(text).lists.length, 0, `${JSON.stringify(text)} must stay outside list continuation`);
  }
  for (const text of ['1)', '12)', '文字\n  12)\t']) {
    assert.equal(makePlan(text).lists.length, 1, `${JSON.stringify(text)} retains the empty ordered-item composer exception`);
  }
});

test('closed fences hide only parser-confirmed syntax inside quote and list containers', () => {
  for (const text of [
    '> ```js\n> x\n> ```', '1. > ```js\n   > x\n   > ```',
    '- ```js\n  x\n  ```', '  ```js\nx\n  ```', '> ~~~~js\n> x\n> ~~~~~',
  ]) {
    const plan = makePlan(text), hidden = plan.markers.map(range => text.slice(range.from, range.to));
    assert.ok(hidden.some(source => /^(?:`{3,}|~{3,})js$/.test(source)), text);
    assert.ok(hidden.some(source => /^(?:`{3,}|~{3,})$/.test(source)), text);
    for (const source of hidden.filter(source => source.includes('`') || source.includes('~'))) {
      assert.match(source, /^(?:`{3,}|~{3,})(?:js)?$/, 'hidden fences never include container prefixes or indentation');
    }
  }
  for (const text of ['> ```js\n> x', '- ```js\n  x', '  ~~~~js\nx\n  ~~~']) {
    assert.ok(!makePlan(text).markers.some(range => /[`~]/.test(text.slice(range.from, range.to))), text);
  }
});

test('pending Markdown markers remain readable inside confirmed containers', () => {
  for (const text of ['#', '##', '  #', '> #', '- #', '> >', '> >引用', '- >', '- >引用']) {
    const plan = makePlan(text), pending = Math.max(text.lastIndexOf('#'), text.lastIndexOf('>'));
    assert.ok(!plan.markers.some(range => range.from <= pending && pending < range.to), text);
    assert.ok(!plan.segments.some(segment => segment.roles.some(role => /^h[1-6]$/.test(role))), text);
  }
  for (const text of ['-', '*', '+', '1.5', '1)word', '```', '```js', '~~~js\ncode']) {
    assert.equal(makePlan(text).markers.length, 0, text);
  }
  for (const text of ['$$\n1) 内容', '\\[\n- 内容', '$unfinished **bold**', '$$\n# 标题']) {
    const plan = makePlan(text);
    assert.equal(plan.markers.length, 0, text);
    assert.equal(plan.lists.length, 0, text);
  }
});

native('nested fence preview keeps exact source, indentation and selection', async () => {
  for (const source of ['> ```js\n> x\n> ```', '- ```js\n  x\n  ```', '1. > ~~~~js\n   > x\n   > ~~~~']) {
    const f = await fixture(source);
    try {
      await tick();
      assert.equal(f.runtime.projection.clipboardText, source);
      assert.equal(snapshot(f).range.to, source.length);
      const hidden = [...f.root.querySelectorAll('[data-lmm-hide]')].map(element => element.textContent);
      assert.ok(hidden.some(text => /^(?:`{3,}|~{3,})js$/.test(text)), source);
      assert.ok(hidden.some(text => /^(?:`{3,}|~{3,})$/.test(text)), source);
      assert.equal(f.adapter.failed, false);
    } finally { f.dispose(); }
  }
});

native('Markdown delimiters across TeX never fragment the native formula leaf', async () => {
  for (const [source, formula] of [['$x*y$ z*', '$x*y$'], ['$x**y$ z**', '$x**y$'], ['$a~~b$ c~~', '$a~~b$']]) {
    const f = await fixture(source);
    try {
      const state = snapshot(f);
      assert.equal(f.runtime.projection.clipboardText, source);
      assert.equal(state.range.to, source.length);
      assert.ok(state.nodes.some(node => node.text === formula && /\bmath-\d+\b/.test(node.style)), source);
      assert.equal(makePlan(source).markers.length, 0, 'unmatched Markdown outside TeX stays visible');
      await tick(); assert.equal(f.adapter.failed, false);
    } finally { f.dispose(); }
  }
});

native('confirmed list variants continue with their indentation, delimiter and separator', async () => {
  for (const [source, marker] of [
    ['-\t内容', '-\t'], ['+  内容', '+  '], ['1.\t内容', '2.\t'], ['12) 内容', '13) '],
    ['  - 内容', '  - '], ['   3)\t内容', '   4)\t'], ['- 父项\n\t- 子项', '\t- '],
    ['> - 内容', '> - '], ['- - 内容', '  - '], ['> 1) - 内容', '>    - '],
  ]) {
    const f = await fixture(source);
    try {
      newline(f); await tick();
      assert.equal(f.runtime.projection.clipboardText, `${source}\n${marker}`, source);
      assert.equal(snapshot(f).range.to, `${source}\n${marker}`.length, 'the caret follows the inherited marker');
      assert.equal(f.adapter.failed, false);
      f.editor.dispatchCommand(api.undo, undefined); await settle();
      assert.equal(f.runtime.projection.clipboardText, source, 'one undo removes the native newline and inherited marker');
      f.editor.dispatchCommand(api.redo, undefined); await settle();
      assert.equal(f.runtime.projection.clipboardText, `${source}\n${marker}`);
    } finally { f.dispose(); }
  }
});

native('whitespace-only items exit without removing their container prefix', async () => {
  for (const [source, expected] of [
    ['-  ', ''], ['-\t', ''], ['+ \t ', ''], ['1. \t', ''], ['12)\t ', ''],
    ['  - \t ', '  '], ['> -\t', '> '], ['- -  ', '- '], ['前文\n  2)\t', '前文\n  '],
  ]) {
    const f = await fixture(source);
    try {
      newline(f); await tick();
      assert.equal(f.runtime.projection.clipboardText, expected, JSON.stringify(source));
      assert.equal(snapshot(f).range.to, expected.length, 'the caret stays at the remaining prefix');
      assert.equal(f.adapter.failed, false);
      f.editor.dispatchCommand(api.undo, undefined); await settle();
      assert.equal(f.runtime.projection.clipboardText, source, 'one undo restores the empty item');
    } finally { f.dispose(); }
  }
});

native('list continuation preserves native references and never rewrites literal source', async () => {
  const f = await fixture('1) 内容 ');
  try {
    let chipKey;
    f.editor.update(() => {
      const chip = new api.ReferenceChipNode({ source: 'file', ref: 'fixture.md', label: 'fixture.md', clipboardText: '@fixture.md' });
      chipKey = chip.getKey(); api.getRoot().getLastChild().append(chip); api.getRoot().selectEnd();
    }, { discrete: true });
    const before = f.runtime.projection.clipboardText, occurrences = f.runtime.projection.occurrences;
    newline(f); await tick();
    assert.equal(f.runtime.projection.clipboardText, `${before}\n2) `);
    assert.deepEqual(f.runtime.projection.occurrences, occurrences);
    assert.equal(f.editor.getEditorState().read(() => api.getRoot().getLastChild().getChildren().some(node => node.getKey() === chipKey)), true);
  } finally { f.dispose(); }
  for (const source of ['```\n-\t内容', '    1) 内容', '<div>\n- 内容', '$$\n1) 内容', '999999999. 内容']) {
    const literal = await fixture(source);
    try {
      newline(literal); await tick();
      assert.equal(literal.runtime.projection.clipboardText, `${source}\n`, source);
      assert.equal(literal.adapter.failed, false);
    } finally { literal.dispose(); }
  }
});

native('ordered items continue at a line end before later paragraphs or references', async () => {
  for (const text of ['1. 第一项\n后续段落', '前文\n1. 第一项\n后续段落']) {
    const f = await fixture(text);
    try {
      if (text.startsWith('前文')) f.editor.update(() => api.getRoot().getFirstChild().append(new api.ReferenceChipNode({ source: 'file', ref: 'fixture.md', label: 'fixture.md', clipboardText: '@fixture.md' })), { discrete: true });
      const before = f.runtime.projection.clipboardText;
      f.editor.update(() => {
        const node = api.getRoot().getAllTextNodes().find(n => n.getTextContent().includes('第一项'));
        node.select(node.getTextContentSize(), node.getTextContentSize());
      }, { discrete: true });
      newline(f); await tick();
      assert.equal(f.runtime.projection.clipboardText, before.replace('第一项\n', '第一项\n2. \n'));
      assert.equal(f.adapter.failed, false);
    } finally { f.dispose(); }
  }
});

native('empty ordered marker after a paragraph renders and exits without numbering plain text', async () => {
  const f = await fixture('给网页做一个功能：\n1.');
  try {
    await tick();
    assert.ok(f.root.querySelector('[data-lmm-role~="olm"]'));
    assert.equal(f.runtime.projection.clipboardText, '给网页做一个功能：\n1.');
    newline(f); await tick();
    assert.equal(f.runtime.projection.clipboardText, '给网页做一个功能：\n');
  } finally { f.dispose(); }
  for (const text of ['```\n1.\n```', '    1.', '<div>\n1.\n</div>', '$$\n1.\n$$']) {
    assert.ok(!makePlan(text).segments.some(segment => segment.roles.includes('olm')), text);
  }
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
    newline(f); await tick();
    assert.equal(f.runtime.projection.clipboardText, '1. 内容\n2. ', 'the new line continues the numbering');
    newline(f); await tick();
    assert.equal(f.runtime.projection.clipboardText, '1. 内容\n', 'Enter on the empty item drops its marker');
    assert.equal(f.adapter.failed, false);
  } finally { f.dispose(); }
  const bullets = await fixture('- 项目');
  try {
    newline(bullets); await tick();
    assert.equal(bullets.runtime.projection.clipboardText, '- 项目\n- ');
  } finally { bullets.dispose(); }
  const plain = await fixture('普通文本');
  try {
    newline(plain); await tick();
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
