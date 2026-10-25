import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--publish-check')) {
  throw new Error('禁止从源码目录直接发布。请先运行 npm run pack:release，再发布生成的 .tgz 包。');
}
for (const arg of args) {
  if (arg !== '--browser') throw new Error(`未知参数：${arg}`);
}
if (!process.env.DSH_NATIVE_RUNTIME) {
  throw new Error('请设置 DSH_NATIVE_RUNTIME。发布包必须通过已审阅原生运行时的验收。');
}

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.private === true) throw new Error('package.json 仍将此包标记为 private。');
const filename = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
if (path.basename(filename) !== filename) throw new Error('包名称或版本不能构成安全的归档文件名。');
const destination = path.join(root, filename);
try {
  await access(destination);
  throw new Error(`候选包已经存在，拒绝覆盖：${destination}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const liveClient = path.join(root, 'lib/client.js');
const before = await digest(liveClient);
const temporaryRoot = await realpath(tmpdir());
const relative = path.relative(await realpath(root), temporaryRoot);
if (!relative || (relative !== '..' && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`))) {
  throw new Error('系统临时目录必须位于插件目录之外。');
}

function run(command, commandArgs, { env = process.env, cwd = root, capture = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd, env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`命令失败（${result.status ?? result.signal}）：${command}${capture ? `\n${result.stderr || result.stdout}` : ''}`);
  }
  return result.stdout;
}

async function npmCommand() {
  const cli = process.env.npm_execpath;
  if (cli && /(?:^|[\\/])npm-cli\.js$/.test(cli)) return [process.execPath, [cli]];
  if (process.platform !== 'win32') return ['npm', []];
  // Run npm's JavaScript entry directly; .cmd requires shell parsing on Windows.
  for (const folder of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(folder, 'node_modules/npm/bin/npm-cli.js');
    try {
      await access(candidate);
      return [process.execPath, [candidate]];
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error('无法定位 npm。请通过 npm run pack:release 运行此脚本。');
}

const temporary = await mkdtemp(path.join(temporaryRoot, 'lmm-npm-release-'));
try {
  const stage = path.join(temporary, 'package');
  const lib = path.join(stage, 'lib');
  const build = path.join(temporary, 'build');
  await mkdir(stage);
  run(process.execPath, ['scripts/check.mjs', ...(args.includes('--browser') ? ['--browser'] : [])], {
    env: { ...process.env, DSH_LMM_BUILD_DIR: build },
  });

  // Copy only runtime entries, never the browser probe's HTML or Chrome profile.
  await mkdir(lib);
  for (const file of ['client.js', 'index.js']) {
    await copyFile(path.join(build, file), path.join(lib, file));
  }
  await copyFile(path.join(build, 'THIRD_PARTY_NOTICES.md'), path.join(stage, 'THIRD_PARTY_NOTICES.md'));
  for (const file of ['cordis.patch.yml', 'README.md', 'LICENSE']) {
    await copyFile(path.join(root, file), path.join(stage, file));
  }
  await mkdir(path.join(stage, 'locale'));
  for (const language of ['en', 'zh']) {
    await copyFile(path.join(root, `locale/${language}.json`), path.join(stage, `locale/${language}.json`));
  }
  const distributed = { ...manifest };
  delete distributed.scripts;
  await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(distributed, null, 2)}\n`, 'utf8');

  const [npm, prefix] = await npmCommand();
  const packed = JSON.parse(run(npm, [...prefix, 'pack', stage, '--ignore-scripts', '--json', '--pack-destination', temporary, '--logs-max=0'], {
    cwd: temporary, capture: true,
  }));
  if (!Array.isArray(packed) || packed.length !== 1) throw new Error('npm pack 没有返回唯一候选包。');
  const result = packed[0];
  const expected = ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'cordis.patch.yml', 'lib/client.js', 'lib/index.js', 'locale/en.json', 'locale/zh.json', 'package.json'].sort();
  const actual = result.files.map(file => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`候选包文件清单不符：${JSON.stringify(actual)}`);
  if (result.name !== manifest.name || result.version !== manifest.version || result.filename !== filename) {
    throw new Error('候选包名称或版本与源码清单不符。');
  }
  await copyFile(path.join(temporary, filename), destination, constants.COPYFILE_EXCL);
} finally {
  try {
    await rm(temporary, { recursive: true, force: true });
  } finally {
    if (await digest(liveClient) !== before) throw new Error('根目录 lib/client.js 摘要发生变化，禁止发布。');
  }
}
console.log(`候选包：${destination}`);
console.log(`SHA256：${await digest(destination)}`);
console.log('原生验收和交付清单检查通过。根目录客户端保持原状。未执行 npm publish。');
