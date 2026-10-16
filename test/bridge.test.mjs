import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftMirror, guard, selectFor, wantsNative } from '../src/bridge.mjs';
import { fakeBridge } from './dom.mjs';

test('CAS mirror preserves raw Markdown and sends once without rendering markup', () => {
  const b = fakeBridge('old'), sync = new DraftMirror(b);
  const raw = '# 中文\n\n$x^2$ **bold**';
  assert.equal(sync.edit(raw), true); assert.equal(b.readInput().draft, raw);
  assert.deepEqual(b.writes[0].span, { start: 0, end: 3, draftRev: 0 });
  assert.equal(sync.submit(), true); assert.deepEqual(b.sends, [raw]);
  sync.refresh(); assert.equal(sync.submit(), false);
});
test('equal text requires no host write', () => {
  const b = fakeBridge('same'); assert.equal(new DraftMirror(b).edit('same'), true); assert.equal(b.writes.length, 0);
});
test('concurrent draft edit retains both versions and never force-overwrites', () => {
  const b = fakeBridge('old'), conflicts = [], sync = new DraftMirror(b, (...args) => conflicts.push(args));
  b.input.set({ ...b.readInput(), draft: 'external', draftRev: 1 });
  assert.equal(sync.edit('local'), false); assert.equal(b.readInput().draft, 'external');
  assert.equal(conflicts[0][0], 'local'); assert.equal(sync.submit(), false);
  assert.equal(sync.refresh(), 'local'); assert.equal(b.writes.length, 0);
});
test('CAS rejection preserves recovery copy', () => {
  const b = fakeBridge('old'); b.actions.insertText = () => false;
  const sync = new DraftMirror(b); assert.equal(sync.edit('new'), false); assert.equal(sync.value, 'new');
});
test('new attachment with unchanged revision blocks mirroring', () => {
  const b = fakeBridge('text'), sync = new DraftMirror(b);
  b.input.set({ ...b.readInput(), attachmentIds: ['a1'] });
  assert.equal(sync.edit('next'), false); assert.equal(b.writes.length, 0); assert.equal(b.readInput().draft, 'text');
});
for (const [label, change] of [
  ['removed', b => b.session.set({ ...b.readSession(), removed: true })],
  ['blank', b => b.session.set({ ...b.readSession(), blank: true })],
  ['awaiting first turn', b => b.session.set({ ...b.readSession(), awaitingFirstTurn: true })],
  ['running', b => b.session.set({ ...b.readSession(), running: true })],
  ['queued input', b => b.input.set({ ...b.readInput(), queue: [{ text: 'next' }] })],
  ['loading', b => b.session.set({ ...b.readSession(), openState: 'loading' })],
  ['blocked', b => b.block.set({ reason: 'model missing' })],
  ['pending approval', b => b.pending.set({ domain: 'approval' })],
  ['parent offline', b => b.session.set({ ...b.readSession(), subagent: { address: { mode: 'continuable' }, parentAvailable: false } })],
  ['readonly child', b => b.session.set({ ...b.readSession(), subagent: { address: { mode: 'readonly' }, parentAvailable: true } })],
  ['claimed', b => b.input.set({ ...b.readInput(), phase: 'claimed', claim: { token: '/cmd' } })],
  ['adjudicating', b => b.input.set({ ...b.readInput(), phase: 'adjudicating' })],
  ['submitting', b => b.input.set({ ...b.readInput(), phase: 'submitting' })],
  ['reference', b => b.input.set({ ...b.readInput(), occurrences: [{ id: 'ref1' }] })],
  ['missing shape', b => b.input.set({ draft: 'x' })],
  ['expired generation', b => b.expire()],
]) test(`${label} blocks all writes and sends`, () => {
  const b = fakeBridge('old'), sync = new DraftMirror(b); change(b);
  assert.ok(guard(b)); assert.equal(sync.submit(), false); assert.equal(sync.edit('new'), false);
  assert.equal(b.writes.length, 0); assert.equal(b.sends.length, 0);
});
test('send detects a change immediately before click', () => {
  const b = fakeBridge('one'), sync = new DraftMirror(b);
  b.input.set({ ...b.readInput(), draft: 'two', draftRev: 1 });
  assert.equal(sync.submit(), false); assert.equal(b.sends.length, 0);
});
test('external host recovery is adopted after settlement', () => {
  const b = fakeBridge('sent'), sync = new DraftMirror(b);
  sync.submit(); assert.equal(sync.refresh(), '');
  b.input.set({ ...b.readInput(), draft: 'restored', draftRev: 2 });
  assert.equal(sync.refresh(), 'restored');
});
test('selector is scope-bound and stable until guarded deferred handoff disposes registration', () => {
  const session = fakeBridge().readSession(), choose = selectFor('s1');
  const match = choose({ sessionId: 's1', session });
  assert.ok(match);
  assert.equal(choose({ sessionId: 's2', session }), null);
  assert.equal(choose({ sessionId: 's1', session, pendingInteraction: {} }), match);
  assert.equal(choose({ sessionId: 's1', session: { ...session, running: true } }), match);
});
test('slash and references use native; ordinary mail and math do not', () => {
  for (const s of ['/help', 'hello @ref', 'hello\n/']) assert.equal(wantsNative(s), true);
  for (const s of ['mail@example.com', '$a/b$', String.raw`$\frac{a}{b}$`]) assert.equal(wantsNative(s), false);
});
const literalDrafts = [
  '$a / b$', '$a /b$', String.raw`\[a / b\]`, '$a @ b$', '$a @ref$',
  '```js\nconst x = a / b; // @ref\n```', '`/help @ref`',
  '$a /', '$a @', String.raw`\[a /`, String.raw`\(a @ref`,
  '$a < b > c /d$', '$\\text{`x`} /y$', 'a / b',
  '$\\text{`x}$ `code @ref`', '$\\text{`x}$ `code /help`',
  '$$\n<div>\n$$\n`code @ref`',
];
for (const draft of literalDrafts) test(`literal context stays live and may submit: ${JSON.stringify(draft)}`, () => {
  assert.equal(wantsNative(draft), false);
  const b = fakeBridge(draft), sync = new DraftMirror(b);
  assert.equal(sync.submit(), true); assert.equal(sync.submit(), false);
  assert.deepEqual(b.sends, [draft]);
});
test('unknown context after budget exhaustion defers command-shaped tokens to native', () => {
  const draft = ('$\\text{`x}$ `code @ref`\n\n').repeat(1000);
  assert.equal(wantsNative(draft), true);
  const b = fakeBridge(draft); assert.equal(new DraftMirror(b).submit(), false); assert.equal(b.sends.length, 0);
});
test('real commands after literal ranges still require native input', () => {
  for (const draft of ['`/example` /help', '$a / b$ @ref', '```\n/ignored\n```\n/', '$a / b$ /help', '$unclosed\n@ref', String.raw`\$text @ref`]) {
    assert.equal(wantsNative(draft), true, draft);
    const b = fakeBridge(draft); assert.equal(new DraftMirror(b).submit(), false); assert.equal(b.sends.length, 0);
  }
});
