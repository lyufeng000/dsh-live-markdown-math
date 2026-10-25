import { renderFormula } from './math.mjs';
import { readLayout, selectionRange, makePlan, applyPlan, ownedStyle, canStyle } from './native-plan.mjs';

export const ADAPTER_REVISION = 'native-rc2-9';

export function compatibleEditor(editor) {
  if (editor?._config?.namespace !== 'dsh-composer') return false;
  if (!['update', 'getEditorState', 'getRootElement', 'getElementByKey', 'registerNodeTransform', 'registerUpdateListener', 'registerRootListener', 'isComposing'].every(key => typeof editor[key] === 'function')) return false;
  const Root = editor._nodes?.get('root')?.klass, Text = editor._nodes?.get('text')?.klass;
  return Root?.getType?.() === 'root' && Text?.getType?.() === 'text' &&
    ['splitText', 'setStyle', 'getStyle', 'getMode'].every(key => typeof Text.prototype[key] === 'function');
}

const activeRange = (selection, range, formula = false) => selection &&
  (selection.from === selection.to
    ? (formula ? selection.from > range.from : selection.from >= range.from) && selection.from < range.to
    : selection.from < range.to && selection.to > range.from);

/** View-only attributes: never insert children into Lexical-owned DOM. */
export function mountNativeAdapter(editor, { onError = () => {} } = {}) {
  if (!compatibleEditor(editor)) return null;
  let disposed = false, failed = false, composing = false, pendingIME = false;
  let root = null, layer = null, frame = null, timer = null, backstop = null, detachRoot = () => {};
  let lastText = null, lastPlan = null;
  const touched = new Set(), formulaCache = new Map(), mathTargets = new Map(), overlays = new Map();
  // A single native newline gesture in this input turn, never inferred from draft text.
  let newlineIntent = null;
  let revealedFormula = null, measureContext;
  const advanceCache = new Map();
  /**
   * Advance of the element's own text under its current font. Measured outside
   * the editor DOM (canvas, else a probe inside our own layer) and cached by
   * font+text, because hidden source is re-measured on every paint.
   */
  function naturalWidth(element, text, win) {
    if (!text) return 0;
    const computed = win.getComputedStyle(element);
    const font = `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
    const key = `${font}|${text}`;
    const cached = advanceCache.get(key);
    if (cached !== undefined) return cached;
    if (advanceCache.size > 2000) advanceCache.clear();
    const doc = element.ownerDocument;
    let width;
    try {
      if (measureContext === undefined) measureContext = typeof doc.createElement('canvas').getContext === 'function' ? doc.createElement('canvas').getContext('2d') : null;
      if (measureContext) { measureContext.font = font; width = measureContext.measureText(text).width; }
      else if (layer) {
        const probe = doc.createElement('span');
        probe.textContent = text;
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${font}`;
        layer.append(probe); width = probe.getBoundingClientRect().width; probe.remove();
      }
    } catch { measureContext = null; }
    width = Number(width);
    // Unmeasurable source stays visible rather than occupying unaccounted room.
    if (!(width > 0)) return 0;
    advanceCache.set(key, width);
    return width;
  }
  /** Cancel the hidden source's advance while keeping its font metrics for the caret. */
  function squeezeSource(element, target, win) {
    const text = element.textContent, width = naturalWidth(element, text, win);
    if (!text.length || !(width > 0)) return;
    element.style.setProperty('--lmm-advance', `${((target - width) / text.length).toFixed(3)}px`);
  }
  const getPlan = text => {
    if (text !== lastText) { lastText = text; lastPlan = makePlan(text); }
    return lastPlan;
  };
  function clearElement(element) {
    element.removeAttribute('data-lmm-role'); element.removeAttribute('data-lmm-hide');
    element.removeAttribute('data-lmm-math');
    // Removing our own override restores the editor's spell-check setting.
    if (element.getAttribute('spellcheck') === 'false') element.removeAttribute('spellcheck');
    element.style.removeProperty('--lmm-width'); element.style.removeProperty('--lmm-height');
    element.style.removeProperty('--lmm-advance'); element.style.removeProperty('--lmm-list-label');
  }
  function clearView() {
    for (const element of touched) clearElement(element);
    touched.clear(); mathTargets.clear(); overlays.clear(); layer?.replaceChildren();
  }
  function fail() {
    if (failed) return;
    failed = true; clearView();
    root?.removeAttribute('data-lmm-native');
    // Never log draft contents or raw exception messages.
    onError('原生编辑器适配已停止；文本、图片与发送仍由 DSH 管理。');
  }
  /**
   * Enter continues a list the way a plain Markdown editor does: the new empty
   * line inherits the next marker, and Enter on that still-empty item drops the
   * marker again and ends the list. The composer breaks lines *inside* a block
   * (a linebreak leaf), so this works on the caret's line rather than on blocks.
   * The adapter writes only the inherited list/container prefix: the user's own
   * words are never touched, and because it runs inside the same update as the
   * line break, one undo removes both.
   */
  function continueList(root, layout, selection) {
    const intent = newlineIntent; newlineIntent = null;
    if (!intent || !selection || selection.from !== selection.to || selection.to !== intent.at + 1) return false;
    const Text = editor._nodes?.get('text')?.klass;
    const last = layout.leaves.find(leaf => leaf.from === intent.at && leaf.type === 'linebreak');
    const block = last?.node.getParent();
    // Only the exact native linebreak at the observed caret. Mount, restore,
    // paste, undo and reference expansion are not newline gestures. A list may
    // precede other paragraphs/chips; it need not end the whole draft.
    if (!Text || !block || block.getKey() !== intent.blockKey ||
      layout.text !== `${intent.text.slice(0, intent.at)}\n${intent.text.slice(intent.at)}`) return false;
    const previousStart = intent.text.lastIndexOf('\n', intent.at - 1) + 1, plan = getPlan(intent.text);
    if (plan.limited) return false;
    // Use the exact markers that the preview accepted. This also handles tabs,
    // indented/nested lists, quote containers and both ordered delimiters.
    const items = plan.lists.filter(item => item.from >= previousStart && item.to <= intent.at)
      .sort((a, b) => a.from - b.from), item = items.at(-1);
    if (!item) return false;
    const source = intent.text.slice(item.from, item.to), tail = intent.text.slice(item.to, intent.at);
    const space = /^[ \t]*/.exec(tail)[0], empty = space.length === tail.length;
    const ordered = /^(\d{1,9})([.)])$/.exec(source);
    if ((!/^[-*+]$/.test(source) && !ordered) || (!space && !empty)) return false;
    if (empty) {
      const leaves = layout.leaves.filter(leaf => leaf.to > item.from && leaf.from < last.to);
      if (leaves.some(leaf => leaf.node.getParent()?.getKey() !== block.getKey() || (leaf !== last && !canStyle(leaf)))) return false;
      // Preserve indentation/quote/outer-list prefixes, even when a marker still
      // shares its TextNode with that prefix. Never remove a chip or foreign node.
      const nodes = leaves.map(leaf => leaf.from < item.from
        ? leaf.node.splitText(item.from - leaf.from)[1] : leaf.node);
      const index = nodes[0].getIndexWithinParent();
      for (const node of nodes) node.remove();
      block.select(index, index);
    } else {
      // An outer list marker on the same line becomes indentation on the next
      // line; quote markers and the user's original whitespace stay intact.
      let prefix = intent.text.slice(previousStart, item.from);
      for (const outer of items.slice(0, -1)) {
        const at = outer.from - previousStart;
        prefix = `${prefix.slice(0, at)}${' '.repeat(outer.to - outer.from)}${prefix.slice(outer.to - previousStart)}`;
      }
      const next = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : source;
      // CommonMark accepts at most nine digits. Do not synthesize a plain-text
      // ten-digit marker when the current list has reached that boundary.
      if (ordered && String(Number(ordered[1]) + 1).length > 9) return false;
      const marker = `${prefix}${next}${space || ' '}`;
      const node = new Text(marker);
      last.node.insertAfter(node);
      node.select(marker.length, marker.length);
    }
    return true;
  }
  function schedule() {
    if (!root || disposed || failed) return;
    const win = root.ownerDocument.defaultView;
    if (frame === null) frame = win.requestAnimationFrame(() => { win.clearTimeout(backstop); backstop = null; frame = null; paint(); });
    // A frame that never arrives (throttled or occluded window) must not freeze
    // the view in a half-updated state, so a slow timer paints anyway.
    if (backstop === null) backstop = win.setTimeout(() => {
      backstop = null;
      if (frame !== null) { win.cancelAnimationFrame(frame); frame = null; }
      paint();
    }, 120);
  }
  /** Clip box shared by both passes: the composer root plus every clipping ancestor. */
  function clipBox() {
    const doc = root.ownerDocument, win = doc.defaultView, rootRect = root.getBoundingClientRect();
    const clip = { left: rootRect.left, right: rootRect.right, top: rootRect.top, bottom: rootRect.bottom };
    for (let parent = root.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
      const style = win.getComputedStyle(parent), rect = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { clip.left = Math.max(clip.left, rect.left); clip.right = Math.min(clip.right, rect.right); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { clip.top = Math.max(clip.top, rect.top); clip.bottom = Math.min(clip.bottom, rect.bottom); }
    }
    return clip;
  }
  /** Place one overlay on its placeholder box and clip it to the visible area. */
  function placeFormula(rendered, element, clip) {
    const rect = element.getBoundingClientRect();
    rendered.style.left = `${rect.left + 1}px`; rendered.style.top = `${rect.top}px`;
    rendered.style.clipPath = `inset(${Math.max(0, clip.top - rect.top)}px ${Math.max(0, rect.right - clip.right)}px ${Math.max(0, rect.bottom - clip.bottom)}px ${Math.max(0, clip.left - rect.left)}px)`;
    rendered.style.visibility = '';
  }
  /**
   * Composition pass: keep the rendered view and only re-glue existing formula
   * overlays, so an input method never sees editor DOM writes. Full paints
   * resume at compositionend.
   */
  function repositionFormulas() {
    if (!layer || !overlays.size) return;
    const doc = root.ownerDocument, state = [];
    for (let element = root; element && element !== doc.body; element = element.parentElement) state.push({ element, top: element.scrollTop, left: element.scrollLeft });
    try {
      const clip = clipBox();
      for (const [element, rendered] of overlays) if (element.isConnected && element.hasAttribute('data-lmm-math')) placeFormula(rendered, element, clip);
    } catch { fail(); } finally {
      for (const { element, top, left } of state) { if (element.scrollTop !== top) element.scrollTop = top; if (element.scrollLeft !== left) element.scrollLeft = left; }
    }
  }
  function paint() {
    if (!root || disposed || failed) return;
    // Temporary source measurement must not clamp a scrolled composer to the
    // raw-text height before taller formula placeholders are restored.
    const scrollState = [];
    for (let element = root; element && element !== root.ownerDocument.body; element = element.parentElement) {
      scrollState.push({ element, top: element.scrollTop, left: element.scrollLeft });
    }
    const restoreScroll = () => {
      for (const { element, top, left } of scrollState) {
        if (element.scrollTop !== top) element.scrollTop = top;
        if (element.scrollLeft !== left) element.scrollLeft = left;
      }
    };
    try {
      const doc = root.ownerDocument, win = doc.defaultView;
      // Composition keeps the last rendered view: clearing it here is what made a
      // rendered line snap back to raw source whenever an input method composed.
      if (composing || editor.isComposing()) { repositionFormulas(); return; }
      const state = editor.getEditorState();
      const { layout, selection, plan } = state.read(() => {
        const layout = readLayout(state._nodeMap.get('root'));
        const selection = selectionRange(state._selection, layout);
        const leaves = layout.leaves.map(leaf => ({ ...leaf, eligible: canStyle(leaf), style: typeof leaf.node.getStyle === 'function' ? leaf.node.getStyle() : '' }));
        return { layout: { ...layout, leaves }, selection, plan: getPlan(layout.text) };
      });
      clearView();
      if (plan.limited) return;
      const focused = doc.activeElement === root || root.contains(doc.activeElement);
      const selected = focused ? selection : null;
      if (revealedFormula && (!focused || layout.text !== revealedFormula.text ||
        (selected && (selected.to < revealedFormula.range.from || selected.from > revealedFormula.range.to)))) revealedFormula = null;
      const candidates = new Map();
      for (const leaf of layout.leaves) {
        if (!leaf.eligible || !ownedStyle(leaf.style)) continue;
        const element = editor.getElementByKey(leaf.key);
        if (!element || !root.contains(element)) continue;
        const roles = leaf.style.slice('--lmm-native: '.length).replace(/;\s*$/, '').split(' ');
        const displayRoles = roles.filter(role => !role.startsWith('marker-') && !role.startsWith('math-'));
        element.setAttribute('data-lmm-role', displayRoles.join(' ')); touched.add(element);
        // Ordered items re-render the source's own number in place of the marker.
        if (displayRoles.includes('olm')) element.style.setProperty('--lmm-list-label', JSON.stringify(element.textContent));
        for (const role of roles) {
          if (role.startsWith('marker-')) {
            const range = plan.markers[Number(role.slice(7))];
            if (range && !activeRange(selected, range)) { element.setAttribute('data-lmm-hide', 'true'); element.setAttribute('spellcheck', 'false'); squeezeSource(element, 0, win); }
          }
          if (role.startsWith('math-')) {
            const id = Number(role.slice(5)), range = plan.formulas[id];
            // Only a complete ordinary text leaf can become a math placeholder.
            // Reference/entity/native-command boundaries must never be hidden.
            // A formula collapses only once the caret has left it: while the caret still sits
            // at the closing delimiter the source keeps its own geometry, so finishing a
            // formula never shifts the line and the caret out from under the user.
            const trailing = selected && selected.from === selected.to && selected.from === range.to;
            if (range && leaf.from === range.from && leaf.to === range.to && leaf.key !== revealedFormula?.key && !activeRange(selected, range, true) && !trailing) candidates.set(id, { range, element, nodeKey: leaf.key });
          }
        }
      }
      if (!layer || !candidates.size) return;
      const computed = win.getComputedStyle(root), rootRect = root.getBoundingClientRect();
      layer.style.fontSize = computed.fontSize; layer.style.color = computed.color;
      // Opaque backdrop for the rendered formula: whatever the hidden source still
      // paints underneath (spell-check markers, selection, underlines) must not
      // show through and turn the line into a pile of shapes.
      let backdrop = '';
      for (let node = root; node && !backdrop; node = node.parentElement) {
        const color = win.getComputedStyle(node).backgroundColor;
        if (color && color !== 'transparent' && !/rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color)) backdrop = color;
      }
      const used = new Set(), positioned = [];
      for (const { range, element, nodeKey } of candidates.values()) {
        const key = `${range.display}:${range.tex}`; used.add(key);
        let cached = formulaCache.get(key);
        if (!cached) {
          const rendered = renderFormula(doc, range.tex, range.display);
          cached = { rendered, valid: rendered.dataset.valid === 'true' }; formulaCache.set(key, cached);
        }
        if (!cached.valid) continue;
        const rendered = cached.rendered.cloneNode(true);
        rendered.classList.add('lmm-native-formula'); rendered.setAttribute('aria-hidden', 'true');
        if (backdrop) rendered.style.background = backdrop;
        rendered.style.visibility = 'hidden'; layer.append(rendered);
        const size = rendered.getBoundingClientRect();
        // No blank invisible placeholders if fonts/layout are unavailable or too wide.
        if (!(size.width > 0 && size.height > 0) || size.width > rootRect.width - 8) { rendered.remove(); continue; }
        const box = Math.ceil(size.width + 2);
        element.style.setProperty('--lmm-width', `${box}px`);
        element.style.setProperty('--lmm-height', `${Math.ceil(size.height)}px`);
        element.setAttribute('data-lmm-math', 'true');
        // Text that is only hidden, never read, must not collect spell-check
        // squiggles: squeezed into the placeholder box they bunch into a red mess
        // over the rendered formula. The editor's own setting returns when shown.
        element.setAttribute('spellcheck', 'false');
        // The hidden TeX is spread over the placeholder box so a caret at either
        // end of the formula lands on the box edge the reader sees.
        squeezeSource(element, box, win);
        mathTargets.set(element, { key: nodeKey, range, text: layout.text });
        overlays.set(element, rendered);
        positioned.push({ element, rendered });
      }
      // All placeholders must have their final size before measuring any line:
      // a later tall formula can move the baseline of an earlier one.
      restoreScroll();
      const clip = clipBox();
      for (const { element, rendered } of positioned) placeFormula(rendered, element, clip);
      for (const key of formulaCache.keys()) if (!used.has(key)) formulaCache.delete(key);
    } catch { fail(); } finally { restoreScroll(); }
  }
  const offUpdate = editor.registerUpdateListener(schedule);
  const offRoot = editor.registerRootListener(next => {
    detachRoot(); root = next;
    if (!next || disposed || failed) return;
    const doc = next.ownerDocument, win = doc.defaultView;
    next.setAttribute('data-lmm-native', ADAPTER_REVISION);
    layer = doc.createElement('div'); layer.className = 'lmm-native-layer';
    layer.setAttribute('aria-hidden', 'true'); doc.body.append(layer);
    // Keep the rendered view during composition; only the transform and full
    // paints pause, so an input method never sees editor DOM writes.
    let pointerStart = null, pointerTimer = null, compositionTimer = null, newlineTimer = null, lastComposition = 0;
    const stopComposition = () => {
      if (!composing && !next.hasAttribute('data-lmm-composing')) return;
      win.clearTimeout(compositionTimer); compositionTimer = null;
      composing = false; next.removeAttribute('data-lmm-composing');
      if (disposed || failed) { schedule(); return; }
      if (pendingIME) {
        pendingIME = false;
        // One settlement after IME, not a second update on every keystroke.
        editor.update(() => editor._pendingEditorState?._nodeMap.get('root')?.markDirty(), { tag: ['history-merge', 'skip-dom-selection', 'lmm-ime-settle'] });
      }
      schedule();
    };
    /** Delayed settlement keeps fast successive compositions from thrashing. */
    const end = () => {
      win.clearTimeout(timer);
      timer = win.setTimeout(() => { timer = null; if (disposed || failed || editor.isComposing()) { schedule(); return; } stopComposition(); }, 32);
    };
    /**
     * A composition that never reports its end (an IME dismissed on focus loss,
     * an interrupted candidate window) must not pause the view forever: the
     * editor itself is the authority on whether a composition is still open.
     */
    const watchdog = () => {
      win.clearTimeout(compositionTimer);
      compositionTimer = win.setTimeout(() => {
        compositionTimer = null;
        if (disposed || failed || !composing) return;
        // The editor's own flag is not enough: a lost compositionend leaves it set
        // too, so only a long silence plus "not composing" resumes the view here.
        if (!editor.isComposing() && win.performance.now() - lastComposition > 2000) { pendingIME = false; stopComposition(); return; }
        watchdog();
      }, 600);
    };
    const start = event => {
      // An input method in another control is not the composer's composition.
      if (event && event.target && !next.contains(event.target)) return;
      composing = true; pendingIME = true; lastComposition = win.performance.now();
      next.setAttribute('data-lmm-composing', 'true');
      watchdog();
    };
    const update = () => { if (composing) { lastComposition = win.performance.now(); watchdog(); } };
    // A composition can only end where it started, but the ending event can be
    // dispatched outside this root; the document is the safe place to notice it.
    const documentEnd = event => { if (!composing) return; if (event?.target && next.contains(event.target)) return; if (editor.isComposing()) return; pendingIME = false; stopComposition(); };
    // A blurred editor cannot be composing: if the end event was lost (IME
    // dismissed by clicking elsewhere), resume here instead of pausing forever.
    const blurred = () => { if (composing) { pendingIME = false; stopComposition(); } };
    const pointer = event => {
      // Clicking into the composer while the editor reports no composition also
      // clears a stale pause, so the next paint is never held back.
      if (composing && !editor.isComposing()) { pendingIME = false; stopComposition(); }
      const element = event.target?.closest?.('[data-lmm-math="true"]');
      const previous = revealedFormula;
      revealedFormula = mathTargets.get(element) ?? null;
      pointerStart = null;
      if (revealedFormula) {
        const rect = element.getBoundingClientRect();
        if (event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          pointerStart = { ...revealedFormula, x: event.clientX, y: event.clientY,
            ratio: rect.width ? (event.clientX - rect.left) / rect.width : 0.5 };
        }
        clearElement(element);
      }
      if (previous || revealedFormula) schedule();
    };
    const pointerEnd = event => {
      const click = pointerStart; pointerStart = null;
      if (!click || event.detail !== 1 || Math.hypot(event.clientX - click.x, event.clientY - click.y) > 4) return;
      // Font-zero placeholders have no reliable browser caret offset. After a
      // simple click (never a drag/shift selection), select INSIDE the same
      // native TextNode. Selection-only: no source write or undo entry.
      win.clearTimeout(pointerTimer);
      pointerTimer = win.setTimeout(() => {
        pointerTimer = null;
        if (disposed || failed || composing || editor.isComposing()) return;
        editor.update(() => {
          const node = editor._pendingEditorState?._nodeMap.get(click.key);
          if (!node || node.getTextContent() !== click.text.slice(click.range.from, click.range.to)) return;
          const offset = Math.max(1, Math.min(node.getTextContentSize() - 1, Math.round(click.ratio * node.getTextContentSize())));
          revealedFormula = click; node.select(offset, offset);
        }, { tag: 'history-merge' });
        schedule();
      }, 0);
    };
    const newline = event => {
      newlineIntent = null; win.clearTimeout(newlineTimer); newlineTimer = null;
      if (disposed || failed || composing || editor.isComposing() || event.isComposing || event.keyCode === 229) return;
      // Observe only. The native keymap still arbitrates/send/handles the event.
      const accepted = event.type === 'keydown'
        ? event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
        : event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph';
      if (!accepted || event.defaultPrevented || !next.contains(event.target)) return;
      try {
        const state = editor.getEditorState();
        const intent = state.read(() => {
          const node = state._nodeMap.get('root'), layout = readLayout(node);
          const selection = selectionRange(state._selection, layout);
          if (!selection || selection.from !== selection.to) return null;
          const at = selection.to;
          // Continue only at a line end, never split or renumber an item's body.
          if (at < layout.text.length && layout.text[at] !== '\n') return null;
          const anchor = state._nodeMap.get(state._selection.anchor.key);
          const block = anchor?.getType() === 'text' || anchor?.getType() === 'linebreak' ? anchor.getParent() : anchor;
          return { text: layout.text, at, blockKey: block?.getKey() };
        });
        newlineIntent = intent;
        // Real beforeinput commits are queued by Lexical after this capture
        // listener. A microtask here ran first and erased the gesture before
        // its transform, even though synchronous synthetic-key tests passed.
        // Expire at the next task; only the exact captured native break matches.
        newlineTimer = win.setTimeout(() => { newlineTimer = null; if (newlineIntent === intent) newlineIntent = null; }, 0);
      } catch { newlineIntent = null; }
    };
    next.addEventListener('keydown', newline, { capture: true, passive: true });
    next.addEventListener('beforeinput', newline, { capture: true, passive: true });
    next.addEventListener('pointerdown', pointer, { capture: true, passive: true });
    next.addEventListener('click', pointerEnd, { capture: true, passive: true });
    next.addEventListener('compositionstart', start, true);
    next.addEventListener('compositionupdate', update, true);
    next.addEventListener('compositionend', end, true);
    next.addEventListener('blur', blurred, true);
    doc.addEventListener('compositionend', documentEnd, true);
    next.addEventListener('focusin', schedule); next.addEventListener('focusout', schedule);
    win.addEventListener('resize', schedule); doc.addEventListener('scroll', schedule, true);
    const resize = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
    resize?.observe(next); doc.fonts?.addEventListener('loadingdone', schedule);
    const ownLayer = layer;
    detachRoot = () => {
      win.cancelAnimationFrame(frame); frame = null; win.clearTimeout(timer); timer = null;
      win.clearTimeout(backstop); backstop = null; win.clearTimeout(compositionTimer); compositionTimer = null;
      win.clearTimeout(pointerTimer); pointerStart = null;
      win.clearTimeout(newlineTimer); newlineTimer = null; newlineIntent = null;
      next.removeEventListener('keydown', newline, true); next.removeEventListener('beforeinput', newline, true);
      next.removeEventListener('pointerdown', pointer, true); next.removeEventListener('click', pointerEnd, true);
      next.removeEventListener('compositionstart', start, true); next.removeEventListener('compositionupdate', update, true);
      next.removeEventListener('compositionend', end, true); next.removeEventListener('blur', blurred, true);
      doc.removeEventListener('compositionend', documentEnd, true);
      next.removeEventListener('focusin', schedule); next.removeEventListener('focusout', schedule);
      win.removeEventListener('resize', schedule); doc.removeEventListener('scroll', schedule, true);
      resize?.disconnect(); doc.fonts?.removeEventListener('loadingdone', schedule);
      clearView(); ownLayer.remove(); if (layer === ownLayer) layer = null;
      next.removeAttribute('data-lmm-native'); next.removeAttribute('data-lmm-composing');
      composing = false; revealedFormula = null;
    };
    schedule();
  });
  let offTransform;
  try {
    offTransform = editor.registerNodeTransform(editor._nodes.get('root').klass, node => {
      if (disposed || failed) return;
      if (composing || editor.isComposing()) { pendingIME = true; return; }
      try {
        let layout = readLayout(node);
        if (continueList(node, layout, selectionRange(editor._pendingEditorState?._selection, layout))) layout = readLayout(node);
        applyPlan(node, getPlan(layout.text), layout);
      } catch { fail(); }
    });
  } catch { fail(); }
  return {
    revision: ADAPTER_REVISION,
    refresh: schedule,
    get failed() { return failed; },
    dispose() {
      if (disposed) return;
      disposed = true; offTransform?.(); offUpdate(); offRoot(); detachRoot();
      root = null; formulaCache.clear();
      // Keep harmless metadata in old undo states. No teardown editor.update,
      // root replacement, lost selection, source rewrite, or new history entry.
    },
  };
}
