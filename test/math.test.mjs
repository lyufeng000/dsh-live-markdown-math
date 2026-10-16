import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDOM } from './dom.mjs';
import { renderFormula } from '../src/math.mjs';
const dom = setupDOM();
after(() => dom.window.close());

test('KaTeX produces accessible HTML and MathML offline', () => {
  const el = renderFormula(document, String.raw`\frac{x^2}{2}+\sqrt{y}`, true);
  assert.equal(el.dataset.valid, 'true'); assert.ok(el.querySelector('.katex')); assert.ok(el.querySelector('math'));
  assert.equal(el.className, 'lmm-formula lmm-display');
});
for (const input of [
  String.raw`\href{javascript:alert(1)}{click}`,
  String.raw`\href{https://example.invalid/secret}{click}`,
  String.raw`\includegraphics{https://example.invalid/tracker}`,
  String.raw`\htmlClass{evil}{x}`,
  String.raw`\htmlStyle{background:url(https://example.invalid/)}{x}`,
  String.raw`\def\a{\a}\a`,
  '<img src=x onerror=alert(1)>',
]) test(`formula security ${input.slice(0, 45)}`, () => {
  const el = renderFormula(document, input);
  assert.equal(el.querySelector('script,iframe,object,embed,img,image,a,foreignObject,style'), null);
  assert.equal(el.querySelector('[href],[src],[xlink\\:href],[onerror],[onclick]'), null);
  for (const n of el.querySelectorAll('[style]')) assert.doesNotMatch(n.getAttribute('style'), /url\s*\(|expression\s*\(/i);
});
test('invalid and oversize TeX falls back to safe literal text', () => {
  for (const tex of [String.raw`\frac{`, 'x'.repeat(4100)]) {
    const el = renderFormula(document, tex); assert.equal(el.dataset.valid, 'false'); assert.equal(el.textContent, tex);
  }
});
test('macro definitions cannot leak into later formulas', () => {
  renderFormula(document, String.raw`\gdef\mysecret{42}\mysecret`);
  assert.equal(renderFormula(document, String.raw`\mysecret`).dataset.valid, 'false');
});
