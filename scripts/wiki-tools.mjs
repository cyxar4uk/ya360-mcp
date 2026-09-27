/**
 * Страница вики «Инструменты» из самого сервера: название, группа прав, вид, описание каждого инструмента
 * и список сценариев. Запуск: npm run wiki:tools → docs/wiki/Инструменты.md
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_GROUPS, GROUPS } from '../src/permissions.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// все сервисы и все права — чтобы сервер показал все инструменты; настоящие ключи не нужны и не используются
const env = {
  ...process.env,
  YANDEX_MCP_HOME: join(root, 'build', 'wiki-home'),
  YANDEX_MCP_PERMISSIONS: 'full',
  YANDEX_LOGIN: 'user@example.ru',
  YANDEX_MAIL_APP_PASSWORD: 'x',
  YANDEX_CALENDAR_APP_PASSWORD: 'x',
  YANDEX_TRACKER_TOKEN: 'x',
  YANDEX_TRACKER_ORG_ID: '1',
  YANDEX_MCP_DOWNLOAD_DIR: '<папка загрузок>', // в описаниях — не ваш локальный путь
};
const client = new Client({ name: 'wiki', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'src', 'index.mjs')], env, stderr: 'ignore' }));
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
await client.close();

const SECTIONS = [
  ['Трекер', (n) => n.startsWith('tracker_')],
  ['Почта', (n) => n.startsWith('mail_')],
  ['Календарь', (n) => n.startsWith('calendar_')],
  ['Служебные', (n) => n.startsWith('yandex_')],
];
const kind = (t) => (t.annotations?.readOnlyHint ? 'чтение' : t.annotations?.destructiveHint ? 'удаление' : 'запись');
// первое предложение; если оно совсем короткое («Поиск задач.») — два
const firstSentence = (s) => {
  const parts = (s ?? '').split(/(?<=[.!?])\s/);
  const text = parts[0].length < 40 && parts[1] ? `${parts[0]} ${parts[1]}` : parts[0];
  return text.replace(/\|/g, '\\|');
};

let md = `# Инструменты

Страница собрана из сервера командой \`npm run wiki:tools\` — не правьте вручную.
Инструменты выключенных групп прав модели не видны (см. [[Права и безопасность|Права-и-безопасность]]).

`;
for (const [title, match] of SECTIONS) {
  const list = tools.filter((t) => match(t.name));
  md += `## ${title}\n\n| Инструмент | Группа прав | Вид | Что делает |\n|---|---|---|---|\n`;
  for (const t of list) md += `| \`${t.name}\` | ${TOOL_GROUPS[t.name] ? `\`${TOOL_GROUPS[t.name]}\`` : 'всегда'} | ${kind(t)} | ${firstSentence(t.description)} |\n`;
  md += '\n';
}
md += `## Группы прав\n\n| Группа | Что разрешает |\n|---|---|\n`;
for (const [g, d] of Object.entries(GROUPS)) md += `| \`${g}\` | ${d} |\n`;
md += `\n## Сценарии\n\nВ плагине Claude Code — \`/ya360:<имя>\` (или \`/<имя>\` после \`ya360-mcp skills install\`), в Claude Desktop — меню «+» → ya360.\n\n| Имя | Название | Когда |\n|---|---|---|\n`;
for (const p of prompts) md += `| \`${p.name}\` | ${p.title} | ${firstSentence(p.description.split(/\s+—\s+/).slice(1).join(' — ') || p.description)} |\n`;

const out = join(root, 'docs', 'wiki', 'Инструменты.md');
writeFileSync(out, md);
console.log(`записано: ${out} (${tools.length} инструментов, ${prompts.length} сценариев)`);
