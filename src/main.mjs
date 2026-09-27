#!/usr/bin/env node
/**
 * Точка входа. Без аргументов (так запускают клиенты MCP) — сервер; с командой — консольная утилита:
 *   yandex-mcp setup | doctor | login | logout | migrate | permissions | register | help
 */

const [command] = process.argv.slice(2);

if (!command || command === 'serve') {
  await import('./index.mjs');
} else {
  const { runCli } = await import('./cli.mjs');
  const code = await runCli(process.argv.slice(2));
  // readline и опрос Яндекса могут держать цикл событий — выходим явно
  process.exit(code);
}
