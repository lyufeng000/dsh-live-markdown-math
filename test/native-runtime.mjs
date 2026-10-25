import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import * as jsx from 'react/jsx-runtime';
import React from 'react';

export const runtimePath = process.env.DSH_NATIVE_RUNTIME;
// Preserve the historical reviewed extraction and pin each independently
// reviewed distribution. A package version alone never admits new code.
export const runtimeSHA = '843dbcd884e05d77e525bf84b9e6dce180fd49ac8486a3c75591c291f09c9afa';
export const reviewedRuntimes = Object.freeze({
  [runtimeSHA]: Object.freeze({ version: '0.2.1-rc.2', source: 'Previously reviewed extracted conversation client' }),
  '8554738cbeeb5218ad1bfa4773ef094363b066d052a1893d7a96797c5bc33a63': Object.freeze({
    version: '0.2.1-rc.2',
    source: 'https://registry.npmjs.org/@deepseek-ai/dsh-client-ui-conversation/-/dsh-client-ui-conversation-0.2.1-rc.2.tgz',
    bodySHA: '4d6a74d5cf6811f2a65e23d1c1b247a8da72399f2219d39f34e6bc0dcf0ac622',
  }),
  '415498ccd102d5359cdcd223009521d8889b6dae01ed83c617c323fe2ea56602': Object.freeze({
    version: '0.2.1-rc.3', source: 'Installed macOS desktop distribution, reviewed against the official rc.2 runtime',
    bodySHA: '4bcf271919fea37b79fcfe3b053c471fe01db7bf33efa3b250fb72ef81f6ee82',
  }),
});
export function runtimeBody(file = runtimePath) {
  if (!file) throw new Error('Set DSH_NATIVE_RUNTIME to a reviewed conversation client fixture');
  const source = fs.readFileSync(file, 'utf8');
  const sha = createHash('sha256').update(source).digest('hex');
  const reviewed = reviewedRuntimes[sha];
  if (!reviewed) throw new Error(`Unreviewed native runtime (${sha}): review the fixture seam before testing`);
  const start = source.indexOf('\t\t//#region ../../../node_modules/.pnpm/lexical@0.49.0_');
  const end = source.indexOf('\t\t//#region lib/types/client/input/facade.js', start);
  if (start < 0 || end < start) throw new Error('Native fixture boundaries missing');
  const body = source.slice(start, end);
  if (reviewed.bodySHA && createHash('sha256').update(body).digest('hex') !== reviewed.bodySHA) throw new Error('Native fixture extraction does not match the reviewed runtime region');
  return body;
}
export const runtimeExports = `return { DraftEditorRuntime, ReferenceChipNode, CommandChipNode, TextRefNode,
  getRoot:nl, getSelection:Kr, createText:Go, createParagraph:es, project:$composerLayout,
  undo:Qe$2, redo:Ze$2, input:je$2, copy:vn$2, paste:Je$2, selectionChange:Ie$2, deleteCharacter:$e$2,
  createEditor:ys, registerHistory:O, createHistory:z, registerPlainText:O$1,
  registerTextRefDecoration, exportHTML:pt };`;
export function loadNativeRuntime() {
  return new Function('react_jsx_runtime', 'react', runtimeBody() + '\n' + runtimeExports)(jsx, React);
}

export function createFixture(api, { text = '', claim = null, lexicon = new Map() } = {}) {
  let runtime;
  const deps = {
    openReference() {}, activeClaimToken: () => claim, lexicon: () => lexicon, resolveLexicon: () => undefined,
    onUpdate: () => runtime.refreshProjection(),
  };
  runtime = new api.DraftEditorRuntime(deps);
  const off = runtime.register(), editor = runtime.editor, errors = [];
  editor._onError = error => errors.push(error.message);
  const root = document.createElement('div'); root.setAttribute('contenteditable', 'true');
  root.tabIndex = 0; document.body.append(root); editor.setRootElement(root); root.focus();
  runtime.setDraft(text);
  return { runtime, editor, root, deps, errors, dispose() { off(); root.remove(); assert.deepEqual(errors, [], 'resident editor must not emit swallowed runtime errors'); } };
}
