import { build } from 'esbuild';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateNotices } from './notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const outputFlag = process.argv.indexOf('--out');
const isolated = outputFlag >= 0;
if (isolated && (!process.argv[outputFlag + 1] || process.argv[outputFlag + 1].startsWith('--'))) throw new Error('--out requires an explicit destination');
const out = isolated ? path.resolve(process.argv[outputFlag + 1]) : path.join(root, 'lib');
// Resolve existing ancestors too: a profile node_modules link must not bypass this guard.
async function resolvedDestination(file) {
  try { return await realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(file) === file) throw error;
    return path.join(await resolvedDestination(path.dirname(file)), path.basename(file));
  }
}
if (isolated) {
  const relativeOutput = path.relative(await realpath(root), await resolvedDestination(out));
  if (!relativeOutput || (relativeOutput !== '..' && !path.isAbsolute(relativeOutput) && !relativeOutput.startsWith(`..${path.sep}`))) {
    throw new Error('Isolated --out must be outside the linked plugin directory; never overwrite live files during checks');
  }
}
await mkdir(out, { recursive: true });

// Inline CSS/fonts: no CDN, no runtime paths, no extra DSH asset endpoint.
const cssText = {
  name: 'inline-scoped-css',
  setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, async ({ path: filename }) => {
      const result = await build({ entryPoints: [filename], bundle: true, write: false, minify: true, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
      let css = result.outputFiles[0].text;
      if (filename.includes('katex')) {
        css = css.replaceAll('KaTeX_', 'LMM_KaTeX_');
        css = css.replace(/([^{}]+)\{/g, (whole, selector) => selector.trim().startsWith('@') ? whole : `${selector.split(',').map(s => `.lmm-formula ${s.trim()}`).join(',')}{`);
      }
      return { contents: `export default ${JSON.stringify(css)};`, loader: 'js' };
    });
  },
};
const client = await build({
  absWorkingDir: root, entryPoints: ['src/client.mjs'], bundle: true, write: false,
  format: 'cjs', platform: 'browser', target: 'chrome120', minify: true,
  external: ['react'], plugins: [cssText], legalComments: 'inline', metafile: true,
});
await writeFile(path.join(out, 'client.js'), `/* ${manifest.name} ${manifest.version} — bundled offline assets */\nwindow.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:require=>{var module={exports:{}},exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`, 'utf8');
await build({ absWorkingDir: root, entryPoints: ['src/index.mjs'], outfile: path.join(out, 'index.js'), bundle: true, format: 'esm', platform: 'node', target: 'node22' });

const notices = await generateNotices(root, client.metafile);
await writeFile(path.join(isolated ? out : root, 'THIRD_PARTY_NOTICES.md'), notices, 'utf8');

if (process.argv.includes('--demo')) {
  const output = await build({ absWorkingDir: root, entryPoints: ['demo/main.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120', minify: true, plugins: [cssText] });
  const escapeHTML = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const template = (await readFile(path.join(root, 'demo/template.html'), 'utf8')).replace('<!-- THIRD_PARTY_NOTICES -->', () => `<details><summary>第三方许可证</summary><pre>${escapeHTML(notices)}</pre></details>`);
  await writeFile(isolated ? path.join(out, 'demo.html') : path.join(root, 'demo/index.html'), template.replace('/* BUNDLE */', () => output.outputFiles[0].text.replaceAll('</script', '<\\/script')), 'utf8');
}
console.log(`Built ${manifest.name}@${manifest.version} (${client.outputFiles[0].contents.length.toLocaleString()} bytes); no profile modified.`);
