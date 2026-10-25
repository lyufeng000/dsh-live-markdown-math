import { analyzeMarkdown, MAX_DOCUMENT } from './markdown.mjs';

export const STYLE_PREFIX = '--lmm-native: ';
export const MAX_SEGMENTS = 6000;
export const ownedStyle = style => typeof style === 'string' && /^--lmm-native: [a-z0-9]+(?:-[0-9]+)?(?: [a-z0-9]+(?:-[0-9]+)?)*;$/.test(style);

/** Offsets use the host's detect projection: chip=U+FFFC, paragraph gap=one LF. */
export function readLayout(root) {
  let text = '';
  const leaves = [], bounds = new Map(), children = new Map();
  function walk(node) {
    const key = node.getKey(), from = text.length, type = node.getType();
    if (typeof node.getChildren === 'function') {
      const kids = node.getChildren(); children.set(key, kids.map(k => k.getKey()));
      for (const child of kids) walk(child);
    } else {
      // 0.2.1 also projects a claimed command chip as one U+FFFC, like a reference chip.
      const value = type === 'reference-chip' || type === 'command-chip'
        ? '\uFFFC'
        : type === 'linebreak' ? '\n' : node.getTextContent();
      text += value;
      leaves.push({ node, key, type, from, to: text.length, text: value });
    }
    bounds.set(key, { from, to: text.length });
  }
  const blocks = root.getChildren(); children.set(root.getKey(), blocks.map(n => n.getKey()));
  blocks.forEach((block, i) => { if (i) text += '\n'; walk(block); });
  bounds.set(root.getKey(), { from: 0, to: text.length });
  return { text, leaves, bounds, children };
}

export function selectionRange(selection, layout) {
  if (!selection?.anchor || !selection?.focus) return null;
  function offset(point) {
    const bounds = layout.bounds.get(point.key);
    if (!bounds) return null;
    if (point.type === 'text') return Math.min(bounds.to, bounds.from + point.offset);
    const kids = layout.children.get(point.key);
    return kids?.[point.offset] ? layout.bounds.get(kids[point.offset])?.from ?? null : bounds.to;
  }
  const anchor = offset(selection.anchor), focus = offset(selection.focus);
  return anchor === null || focus === null ? null : { from: Math.min(anchor, focus), to: Math.max(anchor, focus), anchor, focus };
}

export function canStyle(leaf) {
  return leaf.type === 'text' && leaf.node.getMode() === 'normal' &&
    (leaf.node.getStyle() === '' || ownedStyle(leaf.node.getStyle()));
}

/**
 * A line of hashes alone is a valid empty ATX heading, but while it is still
 * unconfirmed the user may be typing `#include`, `#tag` or `#1`: previewing at
 * that moment hides the very character being typed. This composer deliberately
 * waits for a space or tab before previewing that valid empty heading.
 */
function pendingHeadings(text, nodes) {
  const pending = new Set();
  for (const node of nodes) {
    if (!/^ATXHeading[1-6]$/.test(node.name)) continue;
    const hashes = /^#+/.exec(text.slice(node.from, node.to))?.[0].length ?? 0;
    const next = text[node.from + hashes];
    if (next !== ' ' && next !== '\t') pending.add(node.from);
  }
  return pending;
}

/**
 * The same rule for every space-delimited block marker: `-`, `*`, `+`, `1.` and
 * `>` only preview once their own space is typed, so a decimal like
 * `1.5` and a word like `>引用` mid-type stay plain source. Empty ordered lines
 * are the explicit composer exception, handled separately below.
 */
function pendingListMarks(text, nodes) {
  const pending = new Set();
  for (const node of nodes) {
    if (node.name !== 'ListMark' && node.name !== 'QuoteMark') continue;
    const next = text[node.to];
    if (next !== ' ' && next !== '\t') pending.add(node.from);
  }
  return pending;
}

/** Bounded, source-preserving segmentation. No HTML, URL, or image is executed. */
export function makePlan(text) {
  const parsed = analyzeMarkdown(text), spans = [], markers = [], formulas = [], lists = [];
  if (parsed.limited || text.length > MAX_DOCUMENT) return { segments: [], markers, formulas, lists, limited: true };
  const fences = new Map((parsed.fences ?? []).map(fence => [fence.from, fence]));
  // Nameless literal ranges belong to TeX, including an opener still being
  // typed. Markdown inside them must not hide source or synthesize list text.
  const texLiterals = parsed.literals.filter(range => !range.name).sort((a, b) => a.from - b.from);
  const add = (from, to, role) => { if (from < to) spans.push({ from, to, role }); };
  const marker = (from, to) => {
    const id = markers.length; markers.push({ from, to }); add(from, to, `marker-${id}`);
  };
  // Only the heading/marker and its leading node start at that offset, so skipping
  // the offset leaves the pending run as plain, fully visible source.
  const pending = pendingHeadings(text, parsed.nodes), pendingMarks = pendingListMarks(text, parsed.nodes);
  let literalIndex = 0, literalTo = -1;
  for (const n of parsed.nodes) {
    // Parser enter order and literal starts are monotonic. Charge each literal
    // once, including empty TeX ranges, rather than rescanning them per node.
    while (texLiterals[literalIndex]?.from <= n.from) literalTo = Math.max(literalTo, texLiterals[literalIndex++].to);
    if (n.to <= literalTo) continue;
    const { name, from, to } = n;
    if (pending.has(from) || pendingMarks.has(from)) continue;
    if (/^(ATX|Setext)Heading[1-6]$/.test(name)) add(from, to, `h${name.at(-1)}`);
    // List markers are hidden like other syntax, and the marker leaf alone keeps
    // a role the stylesheet turns into a view-only bullet or the source's number.
    if (name === 'ListMark') {
      const source = text.slice(from, to);
      add(from, to, /^[-*+]$/.test(source) ? 'ulm' : 'olm');
      marker(from, to); lists.push({ from, to });
    }
    if (name === 'StrongEmphasis') add(from, to, 'strong');
    if (name === 'Emphasis') add(from, to, 'em');
    if (name === 'Strikethrough') add(from, to, 'strike');
    if (name === 'Blockquote') add(from, to, 'quote');
    if (name === 'Link') add(from, to, 'link');
    if (['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'QuoteMark'].includes(name)) {
      const end = ['HeaderMark', 'QuoteMark'].includes(name) && text[to] === ' ' ? to + 1 : to;
      marker(from, Math.min(end, text.length));
    }
    if (name === 'InlineCode') {
      add(from, to, 'code');
      const count = /^`+/.exec(text.slice(from, to))?.[0].length ?? 0;
      if (count && to - from > count * 2) { marker(from, from + count); marker(to - count, to); }
    }
    if (name === 'FencedCode' || name === 'CodeBlock') {
      add(from, to, 'codeblock');
      if (name === 'FencedCode') {
        // An unterminated fence is still being typed: keep its backticks visible
        // instead of swallowing the characters the user is entering. Parser
        // offsets preserve quote/list prefixes and closing-line indentation.
        const fence = fences.get(from);
        if (fence?.close) {
          marker(fence.open.from, fence.info?.to ?? fence.open.to);
          marker(fence.close.from, fence.close.to);
        }
      }
    }
  }
  // Empty ordered items can be typed directly after a paragraph. CommonMark
  // does not start a list there until content arrives; the composer still needs
  // to preview the explicit marker and let the next newline end that empty item.
  const orderedStarts = new Set(spans.filter(span => span.role === 'olm').map(span => span.from));
  const protectedRanges = [...parsed.literals, ...parsed.nodes.filter(n =>
    ['FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'InlineCode'].includes(n.name))]
    .sort((a, b) => a.from - b.from || b.to - a.to);
  let protectedIndex = 0;
  for (const match of text.matchAll(/^([ \t]*)(\d{1,9}[.)])([ \t]*)$/gm)) {
    const from = match.index + match[1].length, to = from + match[2].length;
    while (protectedRanges[protectedIndex]?.to <= from) protectedIndex++;
    if (orderedStarts.has(from) || protectedRanges[protectedIndex]?.from <= from) continue;
    add(from, to, 'olm'); marker(from, to); lists.push({ from, to });
    if (spans.length > MAX_SEGMENTS) return { segments: [], markers: [], formulas: [], lists: [], limited: true };
  }
  for (const f of parsed.math) {
    // Multi-paragraph math remains editable source: never collapse native blocks.
    if (/[\r\n\uFFFC]/.test(text.slice(f.from, f.to))) continue;
    const id = formulas.length; formulas.push(f); add(f.from, f.to, `math-${id}`);
  }
  if (spans.length > MAX_SEGMENTS) return { segments: [], markers: [], formulas: [], lists: [], limited: true };
  const events = new Map();
  for (const span of spans) for (const [at, delta] of [[span.from, 1], [span.to, -1]]) {
    if (!events.has(at)) events.set(at, []);
    events.get(at).push([span.role, delta]);
  }
  const points = [...new Set([0, text.length, ...events.keys()])].sort((a, b) => a - b), active = new Map(), segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i], to = points[i + 1];
    for (const [role, delta] of events.get(from) ?? []) {
      const next = (active.get(role) ?? 0) + delta;
      if (next) active.set(role, next); else active.delete(role);
    }
    const roles = [...active.keys()].sort();
    const style = roles.length ? `${STYLE_PREFIX}${roles.join(' ')};` : '';
    const prev = segments.at(-1);
    if (prev?.style === style) prev.to = to;
    else segments.push({ from, to, roles, style });
  }
  return { segments, markers, formulas, lists, limited: segments.length > MAX_SEGMENTS };
}

/** Runs INSIDE the resident Lexical update, before history/projection listeners. */
export function applyPlan(root, plan, layout = readLayout(root)) {
  let cursor = 0, pieces = 0;
  for (const leaf of layout.leaves) {
    if (!canStyle(leaf)) continue;
    while (plan.segments[cursor]?.to <= leaf.from) cursor++;
    const spans = [];
    for (let i = cursor; plan.segments[i]?.from < leaf.to; i++) spans.push(plan.segments[i]);
    if (plan.limited || !spans.length) {
      if (ownedStyle(leaf.node.getStyle())) leaf.node.setStyle('');
      continue;
    }
    pieces += spans.length;
    if (pieces > MAX_SEGMENTS) return false;
    const cuts = spans.slice(1).map(s => s.from - leaf.from).filter(n => n > 0 && n < leaf.text.length);
    const nodes = cuts.length ? leaf.node.splitText(...cuts) : [leaf.node];
    let offset = leaf.from;
    for (const node of nodes) {
      const span = spans.find(s => s.from <= offset && offset < s.to), style = span?.style ?? '';
      if (node.getStyle() !== style) node.setStyle(style);
      offset += node.getTextContentSize();
    }
  }
  return true;
}
