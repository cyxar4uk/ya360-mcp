/**
 * Выкладывает плагин в ветку plugin — её берут витрина (marketplace.json в main) и каталог Claude.
 * В ветке только то, что нужно для работы и проверки: манифест, сборка, сценарии, исходники для чтения и документы.
 * package.json и lockfile туда не попадают, поэтому Claude Code при установке ничего не ставит из npm.
 * --dry — только собрать папку build/plugin-dry и проверить состав (так делает CI).
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dry = process.argv.includes('--dry');
const BRANCH = 'plugin';
const REPO = 'https://github.com/cyxar4uk/ya360-mcp';
const FILES = [
  '.claude-plugin/plugin.json', '.gitattributes', 'dist', 'skills', 'src',
  'README.md', 'README.ru.md', 'LICENSE', 'PRIVACY.md', 'SECURITY.md', 'CHANGELOG.md',
];
const MAX_FILE = 5 * 1024 * 1024; // больше каталог не проверит вовсе

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const git = (args, cwd = root, quiet = false) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) fail(`git ${args.join(' ')} не удался`);
  return (r.stdout ?? '').trim();
};
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === '.git' ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

// ссылки README на файлы репозитория ведут в main: в ветке plugin документов для разработки нет
const absoluteLinks = (md) => md.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, `](${REPO}/blob/main/$1)`);

function stage(dir) {
  for (const f of readdirSync(dir)) if (f !== '.git') rmSync(join(dir, f), { recursive: true, force: true });
  for (const f of FILES) {
    if (!existsSync(join(root, f))) fail(`нет ${f}`);
    mkdirSync(join(dir, f, '..'), { recursive: true });
    cpSync(join(root, f), join(dir, f), { recursive: true });
  }
  for (const f of ['README.md', 'README.ru.md']) writeFileSync(join(dir, f), absoluteLinks(readFileSync(join(dir, f), 'utf8')));

  const plugin = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (plugin.version !== pkg.version) fail(`версии расходятся: plugin.json ${plugin.version}, package.json ${pkg.version}`);
  for (const f of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb']) {
    if (existsSync(join(dir, f))) fail(`${f} в ветке плагина — Claude Code стал бы ставить пакеты`);
  }
  const files = walk(dir);
  for (const f of files) if (statSync(f).size > MAX_FILE) fail(`${relative(dir, f)} больше 5 МБ`);
  return { version: plugin.version, count: files.length };
}

if (dry) {
  const dir = join(root, 'build', 'plugin-dry');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { version, count } = stage(dir);
  console.log(`ветка плагина ${version}: ${count} файлов в ${relative(root, dir)}`);
  process.exit(0);
}

if (git(['status', '--porcelain'])) fail('Есть незакоммиченные изменения — сначала закоммитьте их.');
const sha = git(['rev-parse', 'HEAD']);
git(['fetch', '-q', 'origin']);
if (!git(['branch', '-r', '--contains', sha]).split('\n').some((b) => b.trim() === 'origin/main')) {
  fail('Текущий коммит ещё не в origin/main — сначала отправьте main и дождитесь зелёных проверок.');
}
const check = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs'), '--check'], { stdio: 'inherit' });
if (check.status !== 0) fail('dist не совпадает с исходниками — npm run build.');

const url = git(['remote', 'get-url', 'origin']);
const work = join(root, 'build', 'plugin');
rmSync(work, { recursive: true, force: true });
const exists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', url, BRANCH], { stdio: 'ignore' }).status === 0;
if (exists) {
  git(['clone', '-q', '--depth', '1', '--branch', BRANCH, url, work]);
} else {
  mkdirSync(work, { recursive: true });
  git(['init', '-q', '-b', BRANCH], work);
  git(['remote', 'add', 'origin', url], work);
}
// автор выпуска — тот же, что в основном репозитории
for (const key of ['user.name', 'user.email']) git(['config', key, git(['config', key])], work);
const { version, count } = stage(work);
git(['add', '-A'], work);
if (spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: work }).status === 0) {
  console.log(`Ветка ${BRANCH} уже совпадает с ${sha.slice(0, 7)}.`);
  process.exit(0);
}
git(['commit', '-q', '-m', `выпуск: плагин ${version} из main ${sha.slice(0, 7)}`], work);
git(['push', '-q', 'origin', `HEAD:${BRANCH}`], work);
console.log(`Ветка ${BRANCH}: плагин ${version}, ${count} файлов.`);
