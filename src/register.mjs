/** Подключение сервера к Claude Code (claude mcp add) и Claude Desktop (claude_desktop_config.json). */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export const SERVER_NAME = 'yandex';

/**
 * Как запускать сервер: этот же node и этот же файл входа (абсолютные пути — клиенту не нужен PATH).
 * Если нас запустили из временного кэша npx — регистрируем запуск через npx.
 */
export function launchCommand(entry = process.argv[1]) {
  if (/[\\/]_npx[\\/]/.test(entry)) return { command: 'npx', args: ['-y', 'yandex-mcp'] };
  return { command: process.execPath, args: [resolve(entry)] };
}

function claude(args) {
  let res = spawnSync('claude', args, { encoding: 'utf8', windowsHide: true });
  // установленный через npm claude на Windows — это .cmd, его запускает только оболочка
  if (res.error?.code === 'ENOENT' && process.platform === 'win32') {
    const quoted = args.map((a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
    res = spawnSync('claude', quoted, { encoding: 'utf8', windowsHide: true, shell: true });
  }
  return res;
}

export const hasClaudeCode = () => claude(['--version']).status === 0;

export function registerClaudeCode(launch = launchCommand()) {
  if (claude(['mcp', 'get', SERVER_NAME]).status === 0) claude(['mcp', 'remove', SERVER_NAME, '-s', 'user']);
  const res = claude(['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', launch.command, ...launch.args]);
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || '').trim() || 'claude mcp add не удался');
  return `Claude Code: сервер «${SERVER_NAME}» подключён для всех проектов`;
}

export function desktopConfigPath(platform = process.platform) {
  if (platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Claude', 'claude_desktop_config.json');
}

/** Дописывает сервер в конфиг Claude Desktop, прежний файл сохраняет рядом (.bak). */
export function registerClaudeDesktop(launch = launchCommand(), file = desktopConfigPath()) {
  let data = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`не читается ${file}: ${err.message} — поправь файл вручную`);
    }
    copyFileSync(file, `${file}.bak`);
  }
  data.mcpServers = { ...(data.mcpServers ?? {}), [SERVER_NAME]: { command: launch.command, args: launch.args } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return `Claude Desktop: сервер «${SERVER_NAME}» записан в ${file} — перезапусти приложение`;
}
