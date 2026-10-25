import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function resolvedDestination(file) {
  try { return await realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(file) === file) throw error;
    return path.join(await resolvedDestination(path.dirname(file)), path.basename(file));
  }
}

/** Reject unsafe destinations before either the checker or builder creates files. */
export async function selectBuildDirectory({ requested, rootDir = root, temporaryDir = tmpdir() } = {}) {
  if (requested !== undefined && !path.isAbsolute(requested)) {
    throw new Error('DSH_LMM_BUILD_DIR must be an absolute directory outside the linked plugin directory');
  }
  const destination = await resolvedDestination(requested ?? path.join(temporaryDir, 'lmm-native-check-'));
  const relative = path.relative(await realpath(rootDir), destination);
  if (!relative || (relative !== '..' && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('DSH_LMM_BUILD_DIR must be outside the linked plugin directory; live files must not change during checks');
  }
  return requested === undefined ? mkdtemp(destination) : destination;
}

/** Resolve an explicit override first, then installed Chrome/Chromium executables. */
export async function resolveChrome({ env = process.env, platform = process.platform, userHome = homedir(), canExecute } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const check = canExecute ?? (async file => {
    try { await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return true; }
    catch { return false; }
  });
  const names = platform === 'win32' ? ['chrome.exe', 'chromium.exe'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const search = name => (env.PATH ?? env.Path ?? '').split(paths.delimiter).filter(Boolean).map(folder => paths.join(folder, name));
  if (env.DSH_TEST_CHROME) {
    const override = env.DSH_TEST_CHROME;
    const candidates = paths.isAbsolute(override) || /[\\/]/.test(override) ? [paths.resolve(override)] : search(override);
    for (const file of candidates) if (await check(file)) return file;
    throw new Error(`DSH_TEST_CHROME is not an accessible executable: ${override}`);
  }
  const candidates = [];
  if (platform === 'darwin') {
    for (const base of ['/Applications', paths.join(userHome, 'Applications')]) {
      candidates.push(paths.join(base, 'Google Chrome.app/Contents/MacOS/Google Chrome'), paths.join(base, 'Chromium.app/Contents/MacOS/Chromium'));
    }
  } else if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES ?? env.ProgramFiles, env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)'], env.LOCALAPPDATA ?? env.LocalAppData].filter(Boolean)) {
      candidates.push(paths.join(base, 'Google/Chrome/Application/chrome.exe'), paths.join(base, 'Chromium/Application/chrome.exe'));
    }
  }
  candidates.push(...names.flatMap(search));
  for (const file of new Set(candidates)) if (await check(file)) return file;
  throw new Error('Chrome or Chromium was not found. Set DSH_TEST_CHROME to its executable path.');
}

export async function runCheck() {
  if (!process.env.DSH_NATIVE_RUNTIME) throw new Error('Set DSH_NATIVE_RUNTIME to the reviewed extracted conversation client. Native acceptance must not silently skip.');
  // Validate the reviewed fixture before creating output or launching a browser.
  const { runtimeBody } = await import('../test/native-runtime.mjs');
  runtimeBody();
  const browser = process.argv.includes('--browser');
  const chrome = browser ? await resolveChrome() : undefined;
  const digest = async () => createHash('sha256').update(await readFile(path.join(root, 'lib/client.js'))).digest('hex');
  const before = await digest();
  const out = await selectBuildDirectory({ requested: process.env.DSH_LMM_BUILD_DIR });
  const env = { ...process.env, DSH_LMM_BUILD_DIR: out, ...(chrome ? { DSH_TEST_CHROME: chrome } : {}) };
  const tests = ['audit', 'native', 'client', 'markdown', 'math', 'chat-math', 'package', 'styles'].map(name => `test/${name}.test.mjs`);
  let failed = false;
  for (const args of [['scripts/build.mjs', '--out', out], ['--test', '--test-concurrency=1', ...tests], ...(browser ? [['scripts/probe-native.mjs']] : [])]) {
    const child = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    if (child.error || child.status !== 0) { failed = true; console.error(child.error?.message || `Check failed (${child.status})`); break; }
  }
  if (await digest() !== before) throw new Error('Live client changed during isolated check; investigate before publishing');
  console.log(`Isolated output: ${out}; live client unchanged.`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await runCheck();
