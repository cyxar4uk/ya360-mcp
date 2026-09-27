/**
 * Сборка в один файл dist/ya360-mcp.mjs — без node_modules рядом. Его запускают плагин Claude Code
 * и расширение Claude Desktop. Рядом — dist/THIRD_PARTY_LICENSES.txt: лицензии вшитых зависимостей.
 * `node scripts/build.mjs --check` — проверить, что dist совпадает с исходниками.
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = join(root, 'dist', 'ya360-mcp.mjs');
const licensesFile = join(root, 'dist', 'THIRD_PARTY_LICENSES.txt');
const check = process.argv.includes('--check');

const result = await build({
  entryPoints: [join(root, 'src', 'main.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  keepNames: true,
  legalComments: 'none', // тексты лицензий собираются целиком в THIRD_PARTY_LICENSES.txt
  metafile: true,
  write: !check,
  // CommonJS-зависимости внутри ESM-сборки зовут require — даём им настоящий
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});

/** Пакеты, чей код попал в сборку, с текстами их лицензий. */
function licenses(metafile) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(input.replace(/\\/g, '/'));
    if (m) dirs.add(m[1]);
  }
  const parts = [];
  for (const dir of [...dirs].sort()) {
    const abs = join(root, dir);
    const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
    const file = readdirSync(abs).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    // переводы строк — только LF: иначе сверка dist на другой ОС ложно покажет расхождение
    const text = file
      ? readFileSync(join(abs, file), 'utf8').replace(/\r\n?/g, '\n').trim()
      : `(файла лицензии нет; в package.json: ${pkg.license ?? 'не указана'})`;
    parts.push(`${'='.repeat(78)}\n${pkg.name}@${pkg.version} — ${pkg.license ?? '?'}\n${'='.repeat(78)}\n${text}\n`);
  }
  return `Сторонний код, вшитый в dist/ya360-mcp.mjs (${parts.length} пакетов)\n\n${parts.join('\n')}`;
}

const licenseText = licenses(result.metafile);

if (check) {
  const same = (file, data) => existsSync(file) && Buffer.from(data).equals(readFileSync(file));
  if (!same(outfile, result.outputFiles[0].contents) || !same(licensesFile, licenseText)) {
    console.error('dist устарел — выполни npm run build');
    process.exit(1);
  }
  console.log('dist совпадает с исходниками');
} else {
  writeFileSync(licensesFile, licenseText);
  const count = licenseText.match(/\(\d+ пакетов\)/)?.[0] ?? '';
  console.log(`собрано: dist/ya360-mcp.mjs (${Math.round(readFileSync(outfile).length / 1024)} КБ), лицензии ${count}`);
}
