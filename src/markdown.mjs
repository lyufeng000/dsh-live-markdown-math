import { parser, GFM } from '@lezer/markdown';

export const MAX_DOCUMENT = 100_000;
export const MAX_FORMULA = 4_000;
export const MAX_FORMULAS = 200;
const markdownParser = parser.configure(GFM);
const opaque = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag', 'URL', 'Autolink']);

/** Parse only; never interpret Markdown as HTML or load its remote resources. */
export function analyzeMarkdown(text) {
  if (text.length > MAX_DOCUMENT) return { nodes: [], math: [], literals: [], limited: true };
  let { nodes, exclusions } = parseMarkdown(text);
  const syntax = scanSyntax(text, exclusions, math => {
    // A Markdown span may pair a marker inside TeX with a marker after it.
    // Mask accepted formulas, preserving offsets/newlines, and rebuild the
    // surrounding Markdown contexts instead of merely dropping stale spans.
    const parts = []; let end = 0;
    for (const formula of math) {
      parts.push(text.slice(end, formula.from), text.slice(formula.from, formula.to).replace(/[^\r\n]/g, 'x'));
      end = formula.to;
    }
    parts.push(text.slice(end));
    ({ nodes, exclusions } = parseMarkdown(parts.join('')));
    return exclusions;
  });
  return { nodes, ...syntax };
}

function parseMarkdown(text) {
  const nodes = [], exclusions = [];
  markdownParser.parse(text).iterate({
    enter(node) {
      const range = { name: node.name, from: node.from, to: node.to };
      nodes.push(range);
      if (opaque.has(node.name)) {
        exclusions.push(range);
        return false;
      }
    },
  });
  return { nodes, exclusions };
}

/** Bounded, non-overlapping delimiter scan. Unclosed/oversized expressions stay source. */
export function scanMath(text, excluded = []) { return scanSyntax(text, excluded).math; }

function scanSyntax(text, excluded, reparse) {
  const math = [], literals = [];
  if (text.length > MAX_DOCUMENT) return { math, literals, limited: true };
  // Constant-time escape checks: rescanning the preceding backslashes at each
  // character made a 100k backslash draft quadratic, including in source mode.
  const escapedAt = new Uint8Array(text.length), code = new Uint8Array(text.length);
  let parity = 0;
  for (let i = 0; i < text.length; i++) {
    escapedAt[i] = parity;
    parity = text[i] === '\\' ? parity ^ 1 : 0;
  }
  const markCode = () => {
    code.fill(0);
    for (const { name, from, to } of excluded) {
      if (!name || name === 'FencedCode' || name === 'CodeBlock') code.fill(1, from, to);
    }
  };
  markCode();
  let budget = Math.max(10_000, text.length * 12), cursor = 0, limited = false;
  for (let from = 0; from < text.length; from++) {
    if (--budget <= 0) { limited = true; break; }
    while (excluded[cursor]?.to <= from) cursor++;
    const outer = excluded[cursor];
    if (outer?.from <= from) {
      literals.push(outer); from = outer.to - 1; cursor++; continue;
    }
    if (escapedAt[from]) continue;
    let open, close, display;
    if (text.startsWith('$$', from)) [open, close, display] = ['$$', '$$', true];
    else if (text.startsWith('\\[', from)) [open, close, display] = ['\\[', '\\]', true];
    else if (text.startsWith('\\(', from)) [open, close, display] = ['\\(', '\\)', false];
    else if (text[from] === '$') [open, close, display] = ['$', '$', false];
    else continue;
    const start = from + open.length;
    // Dollar constraints avoid prices such as "$20 and $30".
    if (open === '$' && (!text[start] || /\s/.test(text[start]))) continue;
    const limit = Math.min(text.length, start + MAX_FORMULA + 1);
    let end = start, matched = false, invalidClose = false;
    for (; end < limit; end++) {
      if (--budget <= 0) { limited = true; break; }
      if (code[end] || (!display && /[\r\n]/.test(text[end]))) break;
      // The opener precedes inner HTML tags/backticks/URLs, so TeX owns them.
      // External opaque ranges were skipped above; code blocks remain barriers.
      if (!text.startsWith(close, end) || escapedAt[end]) continue;
      if (close === '$' && (text[end + 1] === '$' || /\s/.test(text[end - 1] ?? '') || /\d/.test(text[end + 1] ?? ''))) {
        invalidClose = true; break;
      }
      if (math.length === MAX_FORMULAS) { limited = true; break; }
      const tex = text.slice(start, end), to = end + close.length;
      if (tex.trim()) math.push({ from, to, contentFrom: start, contentTo: end, tex, display });
      literals.push({ from, to });
      let crossing = false;
      while (excluded[cursor]?.from < to) {
        crossing ||= excluded[cursor].to > to; cursor++;
      }
      if (crossing && reparse) {
        // Charge a full-document pass against the same bounded work budget.
        // Dense ambiguous constructs degrade to source rather than reparse O(n²).
        budget -= text.length;
        if (budget <= 0) { limited = true; break; }
        const next = reparse(math).filter(range => range.to > to);
        // Masking malformed nested syntax can create a new outer span that
        // crosses already accepted math. Don't invent contradictory contexts.
        if (next[0]?.from < to) { limited = true; break; }
        excluded = next; markCode(); cursor = 0;
      }
      from = to - 1; matched = true; break;
    }
    if (limited) break;
    // An unfinished formula is still literal while typing / or @. It is never
    // rendered, and cannot hide triggers beyond a newline/code/size boundary.
    if (!matched && !invalidClose) literals.push({ from, to: end });
    if (open === '$$' && !matched) from++; // Don't reinterpret its second $.
  }
  return { math, literals, limited };
}

export function touchesSelection(from, to, ranges) {
  return ranges.some(range => range.from <= to && range.to >= from);
}

/** Host shortcuts: reject IME confirmation, repeats, and unsupported modifier chords. */
export function enterIntent(event, composing = false, lastCompositionEnd = -Infinity) {
  if (event.key !== 'Enter') return null;
  if (composing || event.isComposing || event.keyCode === 229 || Math.abs(event.timeStamp - lastCompositionEnd) < 50) return 'ime';
  if (event.repeat || event.altKey || event.getModifierState?.('AltGraph') || (event.ctrlKey && event.metaKey)) return 'ignore';
  if (event.shiftKey) return event.ctrlKey || event.metaKey ? 'ignore' : 'newline';
  return event.ctrlKey || event.metaKey ? 'complement' : 'send';
}
