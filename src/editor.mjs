import { Annotation, Compartment, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { analyzeMarkdown, enterIntent, touchesSelection, MAX_DOCUMENT } from './markdown.mjs';
import { renderFormula } from './math.mjs';

export const fromHost = Annotation.define();
export const setLive = StateEffect.define();
const setFocused = StateEffect.define();
const setComposing = StateEffect.define();

const mode = StateField.define({
  create: () => ({ live: true, focused: false, composing: false }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLive)) value = { ...value, live: effect.value };
      if (effect.is(setFocused)) value = { ...value, focused: effect.value };
      if (effect.is(setComposing)) value = { ...value, composing: effect.value };
    }
    return value;
  },
});
const analysis = StateField.define({
  create: state => state.field(mode).live ? analyzeMarkdown(state.doc.toString()) : null,
  update(value, tr) {
    if (!tr.state.field(mode).live) return null; // No preview parsing in source mode.
    return tr.docChanged || value === null ? analyzeMarkdown(tr.state.doc.toString()) : value;
  },
});

class MathWidget extends WidgetType {
  constructor(formula) { super(); this.formula = formula; }
  eq(other) {
    return this.formula.tex === other.formula.tex && this.formula.from === other.formula.from && this.formula.display === other.formula.display;
  }
  toDOM(view) {
    const f = this.formula;
    const node = renderFormula(view.dom.ownerDocument, f.tex, f.display);
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', `编辑公式：${f.tex.slice(0, 200)}`);
    node.title ||= '点击或按 Enter 编辑公式源码';
    const edit = event => {
      event.preventDefault(); event.stopPropagation();
      view.dispatch({ selection: { anchor: f.contentFrom }, effects: setFocused.of(true), scrollIntoView: true });
      view.focus();
    };
    node.addEventListener('mousedown', edit);
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') edit(event);
    });
    return node;
  }
  ignoreEvent() { return true; }
}

const markers = new Set(['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'QuoteMark']);

export function buildDecorations(state) {
  const { live, focused, composing } = state.field(mode);
  if (!live || composing) return Decoration.none;
  const { nodes, math, limited } = state.field(analysis);
  if (limited) return Decoration.none;
  const ranges = [], selections = focused ? state.selection.ranges : [];
  const text = state.doc;
  const activeLine = (from, to = from) => touchesSelection(text.lineAt(from).from, text.lineAt(to).to, selections);
  const overlapsMath = node => math.some(f => node.from < f.to && node.to > f.from);
  const mark = (from, to, name) => { if (from < to) ranges.push(Decoration.mark({ class: name }).range(from, to)); };
  const hide = (from, to) => { if (from < to) ranges.push(Decoration.replace({}).range(from, to)); };
  const lineClasses = new Map();
  const line = (at, cls) => lineClasses.set(at, `${lineClasses.get(at) ?? ''} ${cls}`.trim());

  for (const node of nodes) {
    const { name, from, to } = node;
    if (math.some(f => f.from <= from && to <= f.to)) continue;
    if (/^ATXHeading[1-6]$/.test(name)) line(text.lineAt(from).from, `lmm-heading lmm-h${name.at(-1)}`);
    if (/^SetextHeading[12]$/.test(name)) line(text.lineAt(from).from, `lmm-heading lmm-h${name.at(-1)}`);
    if (name === 'Blockquote') {
      for (let i = text.lineAt(from).number; i <= text.lineAt(to).number; i++) line(text.line(i).from, 'lmm-quote');
    }
    if (name === 'FencedCode' || name === 'CodeBlock') {
      for (let i = text.lineAt(from).number; i <= text.lineAt(to).number; i++) line(text.line(i).from, 'lmm-code-line');
      continue;
    }
    if (overlapsMath(node)) continue;
    if (name === 'StrongEmphasis') mark(from, to, 'lmm-strong');
    if (name === 'Emphasis') mark(from, to, 'lmm-emphasis');
    if (name === 'Strikethrough') mark(from, to, 'lmm-strike');
    if (name === 'InlineCode') {
      mark(from, to, 'lmm-code');
      if (!activeLine(from, to)) {
        const n = /^`+/.exec(text.sliceString(from, to))?.[0].length ?? 0;
        hide(from, from + n); hide(to - n, to);
      }
    }
    if (name === 'Link') mark(from, to, 'lmm-link'); // Deliberately not a clickable <a>.
    if (name === 'ListMark' || name === 'TaskMarker') mark(from, to, 'lmm-list-mark');
    if (markers.has(name)) {
      if (activeLine(from, to)) mark(from, to, 'lmm-marker');
      else hide(from, to);
    }
  }
  for (const formula of math) {
    if (touchesSelection(formula.from, formula.to, selections)) {
      mark(formula.from, formula.to, 'lmm-math-source');
    } else {
      const first = text.lineAt(formula.from), last = text.lineAt(formula.to);
      const wholeLine = formula.display && !text.sliceString(first.from, formula.from).trim() && !text.sliceString(formula.to, last.to).trim();
      ranges.push(Decoration.replace({ widget: new MathWidget(formula), block: wholeLine }).range(
        wholeLine ? first.from : formula.from, wholeLine ? last.to : formula.to,
      ));
    }
  }
  for (const [at, cls] of lineClasses) ranges.push(Decoration.line({ class: cls }).range(at));
  return Decoration.set(ranges, true);
}

const decorations = StateField.define({
  create: buildDecorations,
  update(value, tr) {
    return tr.docChanged || tr.selection || tr.effects.length ? buildDecorations(tr.state) : value;
  },
  provide: field => EditorView.decorations.from(field),
});

/** Host-independent editor. Source is the sole truth; rendering never mutates it. */
export function createLiveEditor(parent, options = {}) {
  const editable = new Compartment();
  let destroyed = false, lastCompositionEnd = -Infinity, composition = false;
  let extensions, readOnly = !!options.readOnly;
  const deferred = effect => queueMicrotask(() => { if (!destroyed) view.dispatch({ effects: effect }); });
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.value ?? '',
      extensions: (extensions = [
        mode, analysis, decorations,
        history(), markdown(), EditorView.lineWrapping,
        placeholder('输入 Markdown；公式用 $…$ 或 $$…$$'),
        editable.of(EditorView.editable.of(!options.readOnly)),
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown 和 LaTeX 消息编辑器', 'aria-multiline': 'true', role: 'textbox', spellcheck: 'false' }),
        Prec.highest(EditorView.domEventHandlers({
          focus: () => { deferred(setFocused.of(true)); },
          blur: () => { deferred(setFocused.of(false)); },
          compositionstart: () => { composition = true; deferred(setComposing.of(true)); options.onCompositionStart?.(); },
          compositionend: event => {
            composition = false; lastCompositionEnd = event.timeStamp;
            deferred(setComposing.of(false));
            options.onCompositionEnd?.();
          },
          paste: event => {
            if (event.clipboardData?.files.length) {
              event.preventDefault(); options.onFiles?.(); return true;
            }
            return false; // Plain-text paste; HTML is never inserted or executed.
          },
          drop: event => {
            if (event.dataTransfer?.files?.length) {
              event.preventDefault(); options.onFiles?.(); return true;
            }
            return false; // Preserve CodeMirror's text insertion/selection move.
          },
          keydown: (event, editor) => {
            const intent = enterIntent(event, composition || editor.composing, lastCompositionEnd);
            if (intent === 'ime') return false;
            if (intent === 'ignore') return true;
            if (intent === 'newline') { event.preventDefault(); return insertNewlineAndIndent(editor); }
            if (intent === 'send' || intent === 'complement') {
              event.preventDefault(); options.onSubmit?.(intent === 'complement'); return true;
            }
            return false;
          },
        })),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.some(tr => tr.annotation(fromHost))) {
            options.onChange?.(update.state.doc.toString(), { composing: composition || view.composing });
          }
        }),
        EditorView.theme({ '&': { fontSize: '14px' }, '.cm-scroller': { fontFamily: 'inherit', maxHeight: 'min(42vh, 360px)', overflow: 'auto' }, '.cm-content': { minHeight: '92px', padding: '12px 0' }, '.cm-line': { padding: '0 14px' }, '&.cm-focused': { outline: 'none' } }),
      ]),
    }),
  });
  if (options.live === false) view.dispatch({ effects: setLive.of(false) });
  return {
    view,
    get value() { return view.state.doc.toString(); },
    get composing() { return composition || view.composing; },
    get limited() { return view.state.doc.length > MAX_DOCUMENT; },
    setValue(value, { resetHistory = true } = {}) {
      const doc = view.state.toText(value); // CRLF/CR normalize before offsets are clamped.
      if (doc.eq(view.state.doc)) return;
      // External replacement/recovery must never make a sent message undoable.
      if (resetHistory) {
        const selection = { anchor: Math.min(view.state.selection.main.head, doc.length) };
        const current = view.state.field(mode);
        view.setState(EditorState.create({ doc, selection, extensions: [extensions, mode.init(() => ({ ...current, composing: false }))] }));
        view.dispatch({ effects: [setLive.of(current.live), setFocused.of(view.hasFocus), editable.reconfigure(EditorView.editable.of(!readOnly))] });
      } else view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: fromHost.of(true) });
    },
    setLive(live) { view.dispatch({ effects: setLive.of(live) }); },
    setReadOnly(value) { readOnly = !!value; view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!readOnly)) }); },
    focus() { view.focus(); },
    destroy() { destroyed = true; view.destroy(); },
  };
}

