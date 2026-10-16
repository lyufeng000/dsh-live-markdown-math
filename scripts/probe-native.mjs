import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { runtimeBody, runtimeExports } from '../test/native-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.env.DSH_LMM_BUILD_DIR;
if (!out || !path.isAbsolute(out)) throw new Error('Set DSH_LMM_BUILD_DIR to the isolated candidate directory');
const chrome = process.env.DSH_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
await fs.access(chrome);
const bundle = await build({ absWorkingDir: root, entryPoints: ['test/browser-native.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120' });
const client = await fs.readFile(path.join(out, 'client.js'), 'utf8');
const source = runtimeBody() + '\n' + runtimeExports;
const escape = script => script.replaceAll('</script', '<\\/script');
const html = `<!doctype html><html><head><meta charset="UTF-8"><title>Isolated native composer probe</title><style>
body{margin:0;padding:64px;font:16px/1.6 system-ui;color:#263140;background:#f6f7f9}#card{max-width:560px;background:#fff;border:1px solid #8893a5;border-radius:12px;padding:16px}[data-input-scroll]{max-height:220px;overflow-y:auto;overflow-x:hidden}#editor{outline:none;white-space:pre-wrap;overflow-wrap:anywhere;min-height:40px}#editor p{margin:0}#footer{padding-top:12px;color:#667085;font-size:13px}h2{font-size:18px}#outside{height:90px}
</style></head><body><h2>原生输入框 · 隔离验证</h2><div id="card"><div data-input-scroll><div id="editor" contenteditable="true" tabindex="0"></div></div><div id="footer">保留原生输入、图片入口与发送逻辑（本页不连接 DSH）</div></div><div id="outside"></div><script>${escape(bundle.outputFiles[0].text)}</script><script>window.__ModuleLoader__={load({factory}){window.plugin=factory(name=>{if(name!=='react')throw Error(name);return window.React})}};</script><script>${escape(client)}</script><script>
plugin.apply({slots:{register(){return ()=>{}},inject(name,fn){[...fn()];return ()=>{}}},effect(fn){fn()}});
window.createNativeProbe(new Function('react_jsx_runtime','react',${JSON.stringify(source)}));
</script></body></html>`;
const pageFile = path.join(out, 'native-probe.html'); await fs.writeFile(pageFile, html);
const profile = await fs.mkdtemp(path.join(out, 'chrome-native-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', '--window-size=960,800', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, session, seq = 0; const pending = new Map(), results = [];
function call(method, params = {}, sid = session) {
  return new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });
}
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, passed: true, detail }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
}
try {
  let lines;
  for (let i = 0; i < 100; i++) {
    try { lines = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); break; }
    catch { await delay(50); }
  }
  if (!lines) throw new Error('Isolated Chrome did not expose its own debug endpoint');
  socket = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data); const item = pending.get(data.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error.message)); else item.resolve(data.result);
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId: session } = await call('Target.attachToTarget', { targetId, flatten: true }, null));
  await call('Page.enable'); await call('Runtime.enable'); await call('Page.navigate', { url: pathToFileURL(pageFile).href });
  for (let i = 0; i < 100 && !await evaluate('!!window.probe'); i++) await delay(50);
  await evaluate('document.fonts.ready.then(()=>probe.wait())');

  await check('native browser typing formats Markdown without a toggle or source loss', async () => {
    await evaluate('probe.set("")');
    const text = '# 标题 **粗体** `code` 😀';
    await call('Input.insertText', { text }); await delay(160);
    const state = await evaluate('probe.snapshot()'); assert.equal(state.text, text);
    assert.ok(state.markers.length >= 3); assert.equal(state.failed, false); assert.deepEqual(state.errors, []);
    return { hiddenMarkers: state.markers.length, text: state.text };
  });
  await check('Enter continues a list, and an empty item ends it', async () => {
    const pressEnter = () => evaluate(`(() => { probe.editor.update(() => { probe.api.getRoot().selectEnd(); probe.api.getSelection().insertLineBreak(); }, {discrete: true}); return probe.project().text; })()`);
    await evaluate(`probe.set(${JSON.stringify('1. 内容')}, 4)`);
    await pressEnter(); await delay(140);
    const continued = await evaluate('probe.snapshot()');
    assert.equal(continued.text, '1. 内容\n2. ', 'the new line continues the numbering');
    assert.ok(continued.markers.some(marker => marker.source === '2.'), 'the inherited marker renders as a list label');
    await pressEnter(); await delay(140);
    const ended = await evaluate('probe.snapshot()');
    assert.equal(ended.text, '1. 内容\n', 'Enter on the empty item drops its marker');
    assert.deepEqual(ended.errors, []);
    return {continued: continued.text, ended: ended.text};
  });
  await check('hidden TeX is not spell-checked and the rendered formula is opaque', async () => {
    await evaluate(`probe.set(${JSON.stringify('公式 $\\frac{1}{2}$ 结束')}, 19)`);
    await delay(220);
    const state = await evaluate(`(() => { const p = probe.root.querySelector('[data-lmm-math="true"]'); const o = document.querySelector('.lmm-native-layer .lmm-native-formula'); return {placeholder: !!p, spell: p ? p.getAttribute('spellcheck') : null, overlay: !!o, bg: o ? getComputedStyle(o).backgroundColor : null, errors: probe.errors.length}; })()`);
    assert.equal(state.placeholder, true, `a math placeholder must exist: ${JSON.stringify(state)}`);
    assert.equal(state.spell, 'false', `hidden TeX must not be spell-checked: ${JSON.stringify(state)}`);
    assert.equal(state.overlay, true, `the formula must be rendered: ${JSON.stringify(state)}`);
    assert.notEqual(state.bg, 'rgba(0, 0, 0, 0)', `the rendered formula must be opaque: ${JSON.stringify(state)}`);
    assert.equal(state.errors, 0);
    return state;
  });  await check('standard lists render a view-only label without losing source', async () => {
    await evaluate(`probe.set(${JSON.stringify('- 第一项\n1. 第二项')})`);
    const state = await evaluate(`(() => {
      const root = probe.root;
      const items = [...root.querySelectorAll('[data-lmm-hide]')].map(e => {
        const pseudo = getComputedStyle(e, '::before');
        return { role: e.getAttribute('data-lmm-role'), source: e.textContent, label: pseudo.content, fill: pseudo.webkitTextFillColor, ownFill: getComputedStyle(e).webkitTextFillColor, hidden: getComputedStyle(e).visibility };
      });
      return { items, text: probe.project().text, errors: probe.errors, failed: probe.adapter.failed };
    })()`);
    assert.equal(state.failed, false); assert.deepEqual(state.errors, []);
    assert.equal(state.text, '- 第一项\n1. 第二项');
    const bullet = state.items.find(item => item.role === 'ulm');
    const ordered = state.items.find(item => item.role === 'olm');
    assert.ok(bullet && ordered, `both list markers are hidden: ${JSON.stringify(state.items)}`);
    assert.ok(bullet.label.includes('\\2022') || bullet.label.includes('•'), `bullet uses a real bullet glyph: ${bullet.label}`);
    assert.ok(ordered.label.includes('1.'), `ordered marker re-renders the source number: ${ordered.label}`);
    for (const item of [bullet, ordered]) {
      assert.equal(item.ownFill, 'rgba(0, 0, 0, 0)', 'hidden source stays transparent');
      assert.notEqual(item.fill, 'rgba(0, 0, 0, 0)', 'generated label must stay visible');
    }
    return state.items;
  });
  await check('composition keeps a rendered line instead of reverting to source', async () => {
    await evaluate(`probe.set(${JSON.stringify('# 标题')}, 3)`);
    const before = await evaluate('probe.snapshot()');
    assert.equal(before.markers.length, 1, 'the heading marker starts hidden');
    let during;
    try {
      await evaluate(`probe.root.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}))`);
      await evaluate('probe.wait()');
      during = await evaluate(`(() => { const s = probe.snapshot(); return {markers: s.markers.length, composing: probe.root.hasAttribute('data-lmm-composing'), text: s.text, errors: s.errors}; })()`);
      assert.equal(during.composing, true, 'composition is flagged');
      assert.equal(during.markers, 1, 'composition must not reveal hidden source');
      // The resident editor inserts a zero-width space anchor while composing;
      // the plugin must leave that alone and never touch the rest of the draft.
      assert.equal(during.text.replaceAll('\u200b', ''), '# 标题', `composition must not rewrite the draft: [${[...during.text].map(c => c.codePointAt(0).toString(16)).join(' ')}]`);
    } finally {
      await evaluate(`probe.root.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: ''}))`);
      await delay(140);
    }
    await evaluate(`probe.set(${JSON.stringify('# 标题')}, 3)`);
    const after = await evaluate('probe.snapshot()');
    assert.equal(after.markers.length, 1, 'the view is still rendered after composition settles');
    assert.deepEqual(after.errors, []);
    return {before: before.markers.length, during: {...during, text: during.text}, after: after.markers.length};
  });
  await check('unconfirmed hash stays visible while typing and never hides mid-word', async () => {
    await evaluate('probe.set("#", 1)');
    const pending = await evaluate('probe.snapshot()'), pendingCaret = await evaluate('probe.caret()');
    assert.equal(pending.markers.length, 0, 'a lone hash must stay plain source before the heading space');
    assert.equal(pending.text, '#');
    assert.ok(pendingCaret.height >= 12, 'caret stays visible while typing a pending hash');
    await call('Input.insertText', { text: 'include' }); await delay(120);
    const word = await evaluate('probe.snapshot()');
    assert.equal(word.text, '#include'); assert.equal(word.markers.length, 0, '#include must never hide the leading hash');
    await evaluate('probe.set("# 标题", 2)');
    const heading = await evaluate('probe.snapshot()'), headingCaret = await evaluate('probe.caret()');
    assert.ok(heading.markers.length >= 1, 'a confirmed heading hides its marker');
    assert.ok(headingCaret.height >= 12, `caret at the heading boundary must stay visible: ${JSON.stringify(headingCaret)}`);
    assert.ok(Math.abs(headingCaret.left - heading.markers[0].rect.left) < 2, 'caret sits where the hidden marker is displayed');
    assert.ok(heading.markers[0].rect.width < 1, 'hidden marker must not occupy width');
    return {pendingCaret, word: word.text, headingCaret, marker: heading.markers[0].rect};
  });
  await check('hidden Markdown and TeX still show a native caret where it lives', async () => {
    await evaluate('probe.set("**bold**", 2)');
    const bold = await evaluate('probe.snapshot()'), boldCaret = await evaluate('probe.caret()');
    assert.ok(boldCaret.height >= 12, `caret at a hidden delimiter boundary must stay visible: ${JSON.stringify(boldCaret)}`);
    assert.ok(boldCaret.left >= bold.markers[0].rect.left - 1 && boldCaret.left <= bold.markers[1].rect.left + 1, 'caret stays between the hidden delimiters');
    // Finishing a formula must not move anything: while the caret still sits on the
    // closing delimiter the source keeps its own geometry and no box is drawn.
    await evaluate('probe.set("$x$", 3)');
    const open = await evaluate('probe.snapshot()'), openCaret = await evaluate('probe.caret()');
    assert.equal(open.placeholders.length, 0, 'a formula must not collapse under its own caret');
    assert.ok(openCaret.height >= 12, `caret on the closing delimiter must stay visible: ${JSON.stringify(openCaret)}`);
    assert.deepEqual(open.errors, []);
    // Once the caret has left it, the formula renders.
    await evaluate(`probe.set(${JSON.stringify('公式 $x$ 后')}, 0)`);
    const math = await evaluate('probe.snapshot()'), mathCaret = await evaluate('probe.caret()');
    assert.equal(math.placeholders.length, 1, 'the formula renders once the caret has left it');
    assert.ok(mathCaret.height >= 12, `caret after a formula placeholder must stay visible: ${JSON.stringify(mathCaret)}`);
    assert.ok(math.placeholders[0].rect.width > 0 && math.placeholders[0].rect.height > 0, 'the placeholder keeps a real box');
    assert.deepEqual(math.errors, []);
    return {boldCaret, openCaret, mathCaret, placeholder: math.placeholders[0].rect};
  });
  await check('tall formulas share final baselines and root height, without bottom clipping', async () => {
    await evaluate(`probe.set(${JSON.stringify('前 $x$ 中 $$\\frac{1}{\\frac{2}{3}}$$ 后')})`);
    const state = await evaluate('probe.snapshot()');
    assert.equal(state.formulas.length, 2); assert.equal(state.placeholders.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.ok(Math.abs(state.formulas[i].rect.top - state.placeholders[i].rect.top) < 1);
      assert.equal(state.formulas[i].clip, 'inset(0px)');
      assert.ok(state.formulas[i].rect.bottom <= state.root.bottom + 1);
    }
    return state;
  });
  await check('mouse click exposes TeX using the resident selection and allows editing', async () => {
    await evaluate(`probe.set(${JSON.stringify('公式 $x^2$ 后')})`);
    const state = await evaluate('probe.snapshot()'), rect = state.placeholders[0].rect;
    await evaluate('window.pointerEvidence=[];document.addEventListener("pointerdown", e=>pointerEvidence.push({target:e.target.outerHTML.slice(0,220),x:e.clientX,y:e.clientY}),{capture:true,once:true})');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: rect.left + rect.width * 0.6, y: rect.top + rect.height * 0.5 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: rect.left + rect.width * 0.6, y: rect.top + rect.height * 0.5 });
    await delay(120);
    const clicked = await evaluate('probe.snapshot()');
    assert.equal(clicked.text, state.text); assert.equal(clicked.formulas.length, 0, `click must reveal editable TeX: ${JSON.stringify({selection:clicked.range,pointer:await evaluate('pointerEvidence'),dom:await evaluate('({text:getSelection().anchorNode?.textContent,offset:getSelection().anchorOffset,html:probe.root.innerHTML})')})}`);
    await call('Input.insertText', { text: 'a' }); await delay(100);
    const edited = await evaluate('probe.snapshot()'); assert.equal(edited.text.length, state.text.length + 1); assert.deepEqual(edited.errors, []);
    return { before: state.text, selection: clicked.range, after: edited.text };
  });
  await check('arrow and deletion cross hidden Markdown delimiters without source loss', async () => {
    await evaluate('probe.set("**bold**")');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await delay(80); const before = await evaluate('probe.snapshot()');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await delay(80); const after = await evaluate('probe.snapshot()');
    assert.equal(before.text, '**bold**'); assert.ok(before.range.from < 8); assert.equal(after.text.length, 7); assert.deepEqual(after.errors, []);
    return { before: before.range, after: after.text };
  });
  await check('scrollport clips long formula drafts and repaint never clamps bottom scroll', async () => {
    const text = Array.from({ length: 28 }, (_, i) => `${i} $$\\frac{a}{\\frac{b}{c}}$$`).join('\n');
    await evaluate(`probe.set(${JSON.stringify(text)})`);
    await evaluate('probe.scroll.scrollTop=probe.scroll.scrollHeight;probe.wait()');
    const before = await evaluate('probe.snapshot()');
    await evaluate('probe.adapter.refresh();probe.wait()'); const after = await evaluate('probe.snapshot()');
    assert.ok(before.maxScroll > 500); assert.ok(Math.abs(before.scrollTop - after.scrollTop) < 1, 'paint must preserve scroll position');
    for (const formula of after.formulas) {
      if (formula.rect.bottom <= after.scroll.top || formula.rect.top >= after.scroll.bottom) assert.notEqual(formula.clip, 'inset(0px)', 'off-scrollport formula must be clipped');
    }
    return { before: before.scrollTop, after: after.scrollTop, max: after.maxScroll, formulas: after.formulas.length };
  });
  await check('selection-only movements do not rewrite native source or replace root', async () => {
    await evaluate('probe.set("**文字** $x$ 😀")');
    const before = await evaluate('probe.project()');
    await evaluate('probe.select(1, 10);probe.wait()');
    const after = await evaluate('probe.snapshot()'); assert.equal(after.text, before.text); assert.deepEqual(after.errors, []);
    assert.equal(await evaluate('probe.editor.getRootElement()===document.getElementById("editor")'), true);
  });
  await evaluate(`probe.set(${JSON.stringify('# 原生无感输入\n**粗体**、_斜体_、`code` 与公式 $E=mc^2$\n> 图片、附件与发送仍由 DSH 管理')})`);
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(out, 'native-preview.png'), Buffer.from(screenshot.data, 'base64'));
  await fs.writeFile(path.join(out, 'browser-results.json'), JSON.stringify({ browser: 'isolated installed Chrome; not live DSH GUI', results }, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.every(r => r.passed), 'Native browser probe contains failures');
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close', {}, null).catch(() => {}); socket.close(); }
  if (child.exitCode === null) child.kill();
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Isolated browser closed')); }
}
