import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Generate notices from the exact packages bundled by esbuild, not a hand-maintained list.
export async function generateNotices(root, metafile) {
  const names = new Set(Object.keys(metafile.inputs).flatMap(file => {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file.replaceAll('\\', '/'));
    return match ? [match[1]] : [];
  }));
  const sections = ['# Third-party notices\n\nGenerated from the bundled package versions. React is supplied by DSH, not bundled. KaTeX font binaries are unchanged; CSS aliases and selectors are namespaced. DOMPurify is used under its Apache-2.0 license option.\n'];
  for (const name of [...names].sort()) {
    const folder = path.join(root, 'node_modules', name);
    const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
    const files = (await readdir(folder)).filter(file => /^(licen[sc]e|copying|notice)(\.|$)/i.test(file)).sort();
    if (!files.length) throw new Error(`Missing license notice: ${name}`);
    sections.push(`## ${name} ${manifest.version}\n\nLicense: ${manifest.license}\n`);
    for (const file of files) sections.push(`### ${file}\n\n\`\`\`text\n${(await readFile(path.join(folder, file), 'utf8')).trim()}\n\`\`\`\n`);
  }
  const fontsDir = path.join(root, 'node_modules/katex/dist/fonts');
  const fontNotices = new Map();
  for (const name of (await readdir(fontsDir)).filter(name => name.endsWith('.ttf')).sort()) {
    const buffer = await readFile(path.join(fontsDir, name));
    let table;
    for (let n = 0; n < buffer.readUInt16BE(4); n++) {
      const record = 12 + 16 * n;
      if (buffer.toString('ascii', record, record + 4) === 'name') { table = buffer.readUInt32BE(record + 8); break; }
    }
    if (table === undefined) throw new Error(`Font name table missing: ${name}`);
    const textBase = table + buffer.readUInt16BE(table + 4), notices = new Set();
    for (let n = 0; n < buffer.readUInt16BE(table + 2); n++) {
      const record = table + 6 + 12 * n;
      const id = buffer.readUInt16BE(record + 6), platform = buffer.readUInt16BE(record);
      if (![0, 13].includes(id)) continue;
      const start = textBase + buffer.readUInt16BE(record + 10), length = buffer.readUInt16BE(record + 8);
      const bytes = Buffer.from(buffer.subarray(start, start + length));
      notices.add((platform === 0 || platform === 3 ? bytes.swap16().toString('utf16le') : bytes.toString('latin1')).trim());
    }
    const text = [...notices].sort().join('\n\n');
    if (!text.includes('SIL Open Font License')) throw new Error(`Font license metadata missing: ${name}`);
    if (!fontNotices.has(text)) fontNotices.set(text, []);
    fontNotices.get(text).push(name);
  }
  sections.push('## KaTeX fonts — SIL Open Font License 1.1\n\nFont copyright and reserved names below are copied from the bundled TTF metadata. The same family is embedded in WOFF/WOFF2 form. Upstream clarification: https://github.com/KaTeX/KaTeX/issues/339\n');
  for (const [text, fonts] of fontNotices) sections.push(`### ${fonts.join(', ')}\n\n\`\`\`text\n${text}\n\`\`\`\n`);
  sections.push(`### Full font license\n\n\`\`\`text\n${(await readFile(path.join(root, 'licenses/OFL-1.1.txt'), 'utf8')).trim()}\n\`\`\`\n`);
  return sections.join('\n');
}
