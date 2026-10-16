import { analyzeMarkdown } from './markdown.mjs';

// This module knows only the documented snapshot/action faces, never Lexical DOM.
export function sessionReason(session, pending) {
  if (!session || session.removed || session.openState !== 'open') return '会话尚未就绪';
  if (session.blank !== false || session.awaitingFirstTurn !== false) return '新会话请先使用原生输入框';
  if (session.running === true) return '运行中的会话使用原生队列与停止操作';
  if (pending != null) return '请先完成审批或提问';
  if (session.subagent != null) return '子会话使用原生输入框';
  return null;
}

export function inputReason(input) {
  if (!input || typeof input.draft !== 'string' || !Number.isSafeInteger(input.draftRev)) return '宿主草稿接口不可用';
  if (input.phase !== 'plain' || input.claim != null) return '命令或发送事务由原生输入框处理';
  if (!Array.isArray(input.occurrences) || input.occurrences.length) return '引用内容由原生输入框处理';
  if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length) return '附件由原生输入框处理';
  if (!Array.isArray(input.queue) || input.queue.length) return '排队消息由原生输入框处理';
  return null;
}

export function wantsNative(text) {
  // A token starts after whitespace, not in mail or a plain division "a / b".
  // Use the same literal contexts for activation, editing, IME, refresh and send.
  const triggers = /(^|\s)[/@](?=\S|$)/gu;
  if (!triggers.test(text)) return false;
  const { literals, limited } = analyzeMarkdown(text);
  if (limited) return true; // Cannot prove the context safely: defer to native.
  triggers.lastIndex = 0;
  let cursor = 0, literalEnd = 0;
  for (const match of text.matchAll(triggers)) {
    const at = match.index + match[1].length;
    while (literals[cursor]?.from <= at) literalEnd = Math.max(literalEnd, literals[cursor++].to);
    if (at >= literalEnd) return true;
  }
  return false;
}

export function guard(bridge) {
  try {
    if (!bridge?.alive() || typeof bridge.actions?.insertText !== 'function' || typeof bridge.actions?.submit !== 'function') return '宿主接口不可用，保留原生输入框';
    return sessionReason(bridge.readSession(), bridge.readPending())
      ?? (bridge.readBlock() != null ? '宿主已暂时禁用输入' : null)
      ?? inputReason(bridge.readInput());
  } catch { return '宿主接口已变化，保留原生输入框'; }
}

/** A synchronous, compare-and-swap mirror. No unmount flush or force overwrite. */
export class DraftMirror {
  constructor(bridge, onConflict = () => {}) {
    this.bridge = bridge;
    this.onConflict = onConflict;
    this.ack = bridge.readInput();
    this.value = this.ack.draft;
    this.conflicted = false;
    this.submitted = false;
  }
  fail(text, reason) {
    this.value = text;
    this.conflicted = true;
    this.conflictReason = reason;
    this.onConflict(text, reason);
    return false;
  }
  edit(text) {
    if (this.conflicted) return this.fail(text, this.conflictReason);
    const reason = guard(this.bridge);
    if (reason) return this.fail(text, reason);
    const current = this.bridge.readInput();
    if (current.draft !== this.ack.draft || current.draftRev !== this.ack.draftRev) return this.fail(text, '草稿已被其他入口修改；未覆盖宿主内容');
    if (current.draft === text) { this.value = text; return true; }
    const accepted = this.bridge.actions.insertText(text, { start: 0, end: current.draft.length, draftRev: current.draftRev });
    if (accepted !== true) return this.fail(text, '宿主拒绝了过期的草稿写入');
    const next = this.bridge.readInput();
    if (next.draft !== text) return this.fail(text, '宿主未确认草稿同步');
    this.ack = next;
    this.value = text;
    return true;
  }
  refresh() {
    if (this.conflicted) return this.value;
    this.ack = this.bridge.readInput();
    this.value = this.ack.draft;
    return this.value;
  }
  submit() {
    if (this.conflicted || this.submitted || guard(this.bridge)) return false;
    const current = this.bridge.readInput();
    if (wantsNative(current.draft) || !current.draft.trim()) return false;
    if (current.draft !== this.value || current.draftRev !== this.ack.draftRev) return this.fail(this.value, '发送前草稿已变化；没有发送');
    this.submitted = true; // Public submit is void; one invocation is not proof of success.
    this.bridge.actions.submit(); // Public rc.2 face: queue; never forge conversation.send.
    return true;
  }
}

export function selectFor(sessionId) {
  const match = Object.freeze({ sessionId });
  // Eligibility was checked before registration. Keep this session's election
  // stable until the component disposes it, so a new pending/running state cannot
  // synchronously tear down an active IME. The component guards every write/send
  // and defers handoff through composition settlement. No mutable selector reads.
  return owner => owner.sessionId === sessionId ? match : null;
}
