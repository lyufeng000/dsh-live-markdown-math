import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import * as jsx from 'react/jsx-runtime';
import React from 'react';

export const runtimePath = process.env.DSH_NATIVE_RUNTIME;
export const runtimeSHA = '843dbcd884e05d77e525bf84b9e6dce180fd49ac8486a3c75591c291f09c9afa';
export function runtimeBody() {
  const source = fs.readFileSync(runtimePath, 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== runtimeSHA) throw new Error('Unreviewed native runtime: update fixture seam before testing');
  const start = source.indexOf('\t\t//#region ../../../node_modules/.pnpm/lexical@0.49.0_');
  const end = source.indexOf('\t\t//#region lib/types/client/input/facade.js', start);
  if (start < 0 || end < start) throw new Error('Native fixture boundaries missing');
  return source.slice(start, end);
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
