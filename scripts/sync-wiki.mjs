/**
 * Выкладывает docs/wiki в вики GitHub: клонирует <репозиторий>.wiki.git в build/wiki, заменяет страницы и отправляет.
 * Источник правды — docs/wiki в репозитории: страницы правятся обычными коммитами.
 * GitHub создаёт репозиторий вики только после первой страницы, сохранённой через сайт.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'docs', 'wiki');
const work = join(root, 'build', 'wiki');
const url = process.env.WIKI_URL || 'https://github.com/cyxar4uk/ya360-mcp.wiki.git';

const git = (args, cwd = work) => {
  const r = spawnSync('git', args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

rmSync(work, { recursive: true, force: true });
const clone = spawnSync('git', ['clone', '--depth', '1', url, work], { stdio: 'inherit' });
if (clone.status !== 0) {
  console.error('\nНе удалось клонировать вики. Включите вики в настройках репозитория и сохраните любую первую страницу на сайте GitHub.');
  process.exit(1);
}
for (const f of readdirSync(work)) if (f.endsWith('.md')) rmSync(join(work, f));
cpSync(src, work, { recursive: true, filter: (p) => !existsSync(p) || !p.includes('.git') });
const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
git(['add', '-A']);
if (spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: work }).status === 0) {
  console.log('Вики уже совпадает с docs/wiki.');
  process.exit(0);
}
git(['commit', '-q', '-m', `доки: вики из docs/wiki (${sha})`]);
git(['push', '-q']);
console.log('Вики обновлена.');
