/**
 * Расширение Claude Desktop: release/ya360-<версия>.mcpb.
 * Берёт готовую сборку dist/ (npm run build), манифест packaging/mcpb/manifest.json с версией из package.json,
 * проверяет манифест официальным mcpb и упаковывает.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stage = join(root, 'build', 'mcpb');
const out = join(root, 'release', `ya360-${pkg.version}.mcpb`);
const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpb.cmd' : 'mcpb');

const run = (args) => {
  const res = spawnSync(bin, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

if (!existsSync(join(root, 'dist', 'ya360-mcp.mjs'))) {
  console.error('нет dist/ya360-mcp.mjs — сначала npm run build');
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
mkdirSync(join(root, 'release'), { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'packaging', 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, 'dist', 'ya360-mcp.mjs'), join(stage, 'server', 'ya360-mcp.mjs'));
cpSync(join(root, 'dist', 'THIRD_PARTY_LICENSES.txt'), join(stage, 'THIRD_PARTY_LICENSES.txt'));
cpSync(join(root, 'README.md'), join(stage, 'README.md'));
cpSync(join(root, 'README.en.md'), join(stage, 'README.en.md'));
// сценарии — сервер отдаёт их как подсказки в Claude Desktop
cpSync(join(root, 'skills'), join(stage, 'skills'), { recursive: true });

run(['validate', join(stage, 'manifest.json')]);
run(['pack', stage, out]);
console.log(`готово: ${out}`);
