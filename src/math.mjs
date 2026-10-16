import katex from 'katex';
import createDOMPurify from 'dompurify';
import { MAX_FORMULA } from './markdown.mjs';

const purifiers = new WeakMap();

/** Only generated KaTeX markup enters the sanitizer, never Markdown/user HTML. */
export function renderFormula(document, tex, display = false) {
  const node = document.createElement('span');
  node.className = display ? 'lmm-formula lmm-display' : 'lmm-formula';
  try {
    if (tex.length > MAX_FORMULA) throw new Error('Formula too long');
    const html = katex.renderToString(tex, {
      displayMode: display,
      output: 'htmlAndMathml',
      throwOnError: true,
      trust: false,
      strict: 'error',
      maxExpand: 200,
      maxSize: 10,
      macros: {},
      globalGroup: false,
    });
    if (html.length > 200_000) throw new Error('Formula output too large');
    const window = document.defaultView;
    let purify = purifiers.get(window);
    if (!purify) { purify = createDOMPurify(window); purifiers.set(window, purify); }
    // Native setHTML's conservative style filtering breaks KaTeX geometry. Use
    // DOMPurify's HTML+MathML+SVG support and insert a fragment (no reparse/mXSS).
    const fragment = purify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'img', 'image', 'a', 'foreignObject', 'annotation-xml'],
      FORBID_ATTR: ['href', 'src', 'xlink:href', 'formaction'],
      ALLOW_DATA_ATTR: false,
    });
    node.append(fragment);
    node.dataset.valid = 'true';
  } catch {
    // Do not interpolate KaTeX errors: they can include unescaped user input.
    node.textContent = tex;
    node.classList.add('lmm-math-error');
    node.title = '公式尚未完成或不受支持，点击编辑源码';
    node.dataset.valid = 'false';
  }
  return node;
}
