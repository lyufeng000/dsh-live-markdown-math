import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarkdown, scanMath, enterIntent, touchesSelection, MAX_DOCUMENT, MAX_FORMULAS } from '../src/markdown.mjs';

for (const [text, tex, display] of [
  ['$x^2$', 'x^2', false], ['$$x\ny$$', 'x\ny', true],
  [String.raw`\(\frac{a}{b}\)`, String.raw`\frac{a}{b}`, false],
  [String.raw`\[\int_0^1 x dx\]`, String.raw`\int_0^1 x dx`, true],
]) test(`math delimiter ${JSON.stringify(text)}`, () => {
  const found = analyzeMarkdown(text).math;
  assert.equal(found.length, 1); assert.equal(found[0].tex, tex); assert.equal(found[0].display, display);
  assert.equal(text.slice(found[0].from, found[0].to), text);
});

test('code and raw HTML are opaque', () => {
  for (const text of ['`$x$`', '```tex\n$x$\n```', '    $x$', '<div>$x$</div>', '[link](https://example.invalid/$x$)']) assert.equal(analyzeMarkdown(text).math.length, 0, text);
});
test('escaped delimiters, prices and incomplete formula stay literal', () => {
  for (const text of [String.raw`\$x\$`, '$20 and $30', '$ x $', '$x', '$$x', '$x\ny$']) assert.equal(analyzeMarkdown(text).math.length, 0, text);
});
test('escaped dollars inside a formula do not close it', () => assert.equal(scanMath(String.raw`$x\$y$`)[0].tex, String.raw`x\$y`));
for (const raw of ['$a<b>c$', '$a < b > c$', '$\\text{`x`}$', '$$\n<a>\n$$', String.raw`\[a < b > c\]`]) {
  test(`math takes precedence over inner Markdown: ${JSON.stringify(raw)}`, () => {
    const found = analyzeMarkdown(raw).math;
    assert.equal(found.length, 1); assert.equal(raw.slice(found[0].from, found[0].to), raw);
  });
}
test('math cannot start in external code/HTML/URLs or consume a fenced code block', () => {
  for (const raw of ['`$a<b>c$`', '~~~tex\n$a<b>c$\n~~~', '<div>$a<b>c$</div>',
    '[x](https://example.invalid/$a$)', '$$outside\n```\ninside$$\n```']) {
    assert.equal(analyzeMarkdown(raw).math.length, 0, raw);
  }
});
test('an inner backtick span cannot hide a later formula after the first closes', () => {
  assert.deepEqual(analyzeMarkdown('$a`b$ then $c$ `').math.map(f => f.tex), ['a`b', 'c']);
});
test('math-internal markers cannot swallow subsequent external code, HTML or URL contexts', () => {
  for (const prefix of ['$\\text{`x}$', '$$\n<div>\n$$']) {
    for (const tail of ['`$y$`', '<div>$y$</div>', '[link](https://example.invalid/$y$)']) {
      const raw = `${prefix}\n\n${tail}`, parsed = analyzeMarkdown(raw);
      assert.equal(parsed.limited, false, raw); assert.equal(parsed.math.length, 1, raw);
      assert.equal(raw.slice(parsed.math[0].from, parsed.math[0].to), prefix);
      assert.ok(parsed.nodes.some(n => ['InlineCode', 'HTMLBlock', 'URL'].includes(n.name) && n.from >= prefix.length), raw);
    }
  }
});
test('contradictory reparsed outer spans degrade safely without unordered literals', () => {
  for (const raw of [String.raw`<a f="\[<a f="\]">`, String.raw`<a f=" @\[<a f="\]">`]) {
    const parsed = analyzeMarkdown(raw); assert.equal(parsed.limited, true);
    let previous = 0;
    for (const range of parsed.literals) {
      assert.ok(range.from >= previous && range.from <= range.to && range.to <= raw.length);
      previous = range.from;
    }
  }
});
test('ambiguous Markdown-context rebuilding is bounded and degrades to source', () => {
  const raw = ('$\\text{`x}$ `code @ref`\n\n').repeat(1000), start = performance.now();
  assert.equal(analyzeMarkdown(raw).limited, true);
  assert.ok(performance.now() - start < 1500, 'reparsing must share the bounded scan budget');
});
test('backslash runs and escape parity are linear at the document limit', () => {
  const start = performance.now();
  assert.equal(scanMath('\\'.repeat(MAX_DOCUMENT)).length, 0);
  assert.equal(analyzeMarkdown('\\'.repeat(MAX_DOCUMENT)).limited, false);
  assert.ok(performance.now() - start < 1500, '100k backslashes must not freeze the editor for seconds');
  assert.equal(scanMath('\\'.repeat(20000) + '$x$').length, 1);
  assert.equal(scanMath('\\'.repeat(20001) + '$x$').length, 0);
});
test('several formulas retain exact ranges', () => {
  const text = '中文 $x$ + $y$\n\n$$z$$';
  assert.deepEqual(analyzeMarkdown(text).math.map(f => text.slice(f.from, f.to)), ['$x$', '$y$', '$$z$$']);
});
test('GFM syntax nodes are available', () => {
  const names = new Set(analyzeMarkdown('# Title\n\n**bold** *italic* ~~gone~~\n\n- [x] done\n\n> quote').nodes.map(n => n.name));
  for (const n of ['ATXHeading1', 'StrongEmphasis', 'Emphasis', 'Strikethrough', 'Blockquote']) assert.ok(names.has(n), n);
});
test('document and formula counts are bounded', () => {
  assert.equal(analyzeMarkdown('x'.repeat(MAX_DOCUMENT + 1)).limited, true);
  assert.equal(scanMath('$x$ '.repeat(300)).length, MAX_FORMULAS);
  assert.equal(scanMath('$' + 'x'.repeat(4100) + '$').length, 0);
});
test('unmatched openers have bounded scan work', () => {
  const start = performance.now();
  analyzeMarkdown(String.raw`\[x`.repeat(30000));
  assert.ok(performance.now() - start < 2000);
});
test('selection intersection includes formula edges', () => {
  assert.equal(touchesSelection(5, 10, [{ from: 5, to: 5 }]), true);
  assert.equal(touchesSelection(5, 10, [{ from: 10, to: 10 }]), true);
  assert.equal(touchesSelection(5, 10, [{ from: 0, to: 4 }]), false);
});
for (const [event, composing, last, expected] of [
  [{ key: 'Enter' }, false, -Infinity, 'send'],
  [{ key: 'Enter', shiftKey: true }, false, -Infinity, 'newline'],
  [{ key: 'Enter', ctrlKey: true }, false, -Infinity, 'complement'],
  [{ key: 'Enter', metaKey: true }, false, -Infinity, 'complement'],
  [{ key: 'Enter', isComposing: true }, false, -Infinity, 'ime'],
  [{ key: 'Enter', keyCode: 229 }, false, -Infinity, 'ime'],
  [{ key: 'Enter' }, true, -Infinity, 'ime'],
  [{ key: 'Enter', timeStamp: 120 }, false, 100, 'ime'],
  [{ key: 'Enter', repeat: true }, false, -Infinity, 'ignore'],
  [{ key: 'Enter', altKey: true }, false, -Infinity, 'ignore'],
  [{ key: 'Enter', ctrlKey: true, shiftKey: true }, false, -Infinity, 'ignore'],
  [{ key: 'x' }, false, -Infinity, null],
]) test(`keyboard ${JSON.stringify(event)} -> ${expected}`, () => assert.equal(enterIntent(event, composing, last), expected));
