/**
 * Дымовая проверка: поднимает сервер как настоящий клиент MCP, печатает список инструментов
 * и результат yandex_status. Дополнительно можно вызвать любой инструмент:
 *   node test/smoke.mjs tracker_get_issue '{"key":"PROJ-1"}'
 * Переменные окружения передаются серверу как есть (например, YANDEX_MCP_READONLY=1).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Инструментов: ${tools.length}`);
for (const t of tools) {
  const kind = t.annotations?.readOnlyHint ? 'чтение' : t.annotations?.destructiveHint ? 'удаление' : 'запись';
  console.log(`  ${t.name.padEnd(28)} ${kind}`);
}

const show = (res) => console.log((res.isError ? 'ОШИБКА ' : '') + res.content.map((c) => c.text).join('\n'));
show(await client.callTool({ name: 'yandex_status', arguments: {} }));

const [name, json] = process.argv.slice(2);
if (name) {
  console.log(`\n→ ${name}`);
  show(await client.callTool({ name, arguments: json ? JSON.parse(json) : {} }));
}
await client.close();
