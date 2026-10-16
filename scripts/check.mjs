import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.DSH_NATIVE_RUNTIME) throw new Error('Set DSH_NATIVE_RUNTIME to the reviewed extracted rc.2 conversation client. Native acceptance must not silently skip.');
const temporary = 'D:/Data/.temp'; await mkdir(temporary, { recursive: true });
const out = process.env.DSH_LMM_BUILD_DIR || await mkdtemp(path.join(temporary, 'lmm-native-check-'));
const env = { ...process.env, DSH_LMM_BUILD_DIR: out };
const digest = async () => createHash('sha256').update(await readFile(path.join(root, 'lib/client.js'))).digest('hex');
const before = await digest();
const tests = ['native', 'client', 'markdown', 'math', 'chat-math', 'package', 'styles'].map(name => `test/${name}.test.mjs`);
let failed = false;
for (const args of [['scripts/build.mjs', '--out', out], ['--test', '--test-concurrency=1', ...tests], ...(process.argv.includes('--browser') ? [['scripts/probe-native.mjs']] : [])]) {
  const child = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (child.error || child.status !== 0) { failed = true; console.error(child.error?.message || `Check failed (${child.status})`); break; }
}
if (await digest() !== before) throw new Error('Live client changed during isolated check; investigate before publishing');
console.log(`Isolated output: ${out}; live client unchanged.`);
if (failed) process.exitCode = 1;
