/** Подключение сервера к Claude Code (claude mcp add) и Claude Desktop (claude_desktop_config.json). */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export const SERVER_NAME = 'yandex';

/**
 * Как запускать сервер: этот же node и этот же файл входа (абсолютные пути — клиенту не нужен PATH).
 * temporary — запуск из кэша npx (папку могут удалить); plugin — копия внутри плагина Claude Code
 * (сервер уже подключён плагином, а папка меняется при обновлении).
 */
export function launchCommand(entry = process.argv[1]) {
  const path = resolve(entry);
  return {
    command: process.execPath,
    args: [path],
    temporary: /[\\/]_npx[\\/]/.test(path),
    plugin: !!process.env.CLAUDE_PLUGIN_ROOT || /[\\/]\.claude[\\/]plugins[\\/]/.test(path),
  };
}

/** Почему этот запуск нельзя регистрировать; null — можно. */
export function registrationBlocker(launch) {
  if (launch.plugin) return 'это копия из плагина Claude Code — сервер уже подключён плагином, отдельно регистрировать не нужно';
  if (launch.temporary) return 'запущено из временной папки npx — клонируйте репозиторий (или установите пакет) и запустите setup оттуда';
  return null;
}

function claude(args) {
  let res = spawnSync('claude', args, { encoding: 'utf8', windowsHide: true });
  // установленный через npm claude на Windows — это .cmd, его запускает только оболочка
  if (res.error?.code === 'ENOENT' && process.platform === 'win32') {
    const quoted = args.map((a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
    res = spawnSync('claude', quoted, { encoding: 'utf8', windowsHide: true, shell: true });
  }
  return res;
}

export const hasClaudeCode = () => claude(['--version']).status === 0;

/** Как сейчас подключён сервер в Claude Code: строка команды или null. */
export function claudeCodeCurrent() {
  const res = claude(['mcp', 'get', SERVER_NAME]);
  if (res.status !== 0) return null;
  const cmd = /Command:\s*(.+)/.exec(res.stdout)?.[1]?.trim() ?? '';
  const args = /Args:\s*(.+)/.exec(res.stdout)?.[1]?.trim() ?? '';
  return `${cmd} ${args}`.trim() || 'подключён';
}

export const sameLaunch = (current, launch) =>
  !!current && current.replace(/\\/g, '/').toLowerCase() === `${launch.command} ${launch.args.join(' ')}`.replace(/\\/g, '/').toLowerCase();

/** Регистрирует в Claude Code; прежнюю запись с тем же именем заменяет — спрашивать об этом должен вызывающий. */
export function registerClaudeCode(launch = launchCommand()) {
  const blocker = registrationBlocker(launch);
  if (blocker) throw new Error(blocker);
  if (claudeCodeCurrent()) claude(['mcp', 'remove', SERVER_NAME, '-s', 'user']);
  const res = claude(['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', launch.command, ...launch.args]);
  if (res.status !== 0) throw new Error((res.stderr || res.stdout || '').trim() || 'claude mcp add не удался');
  return `Claude Code: сервер «${SERVER_NAME}» подключён для всех проектов`;
}

export function desktopConfigPath(platform = process.platform) {
  if (platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Claude', 'claude_desktop_config.json');
}

function readDesktop(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`не читается ${file}: ${err.message} — поправь файл вручную`);
  }
}

/** Есть ли уже сервер с нашим именем в конфиге Claude Desktop. */
export const desktopHasServer = (file = desktopConfigPath()) => !!readDesktop(file).mcpServers?.[SERVER_NAME];

/** Дописывает сервер в конфиг Claude Desktop, прежний файл сохраняет рядом (.bak). */
export function registerClaudeDesktop(launch = launchCommand(), file = desktopConfigPath()) {
  const blocker = registrationBlocker(launch);
  if (blocker) throw new Error(blocker);
  const data = readDesktop(file);
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  data.mcpServers = { ...(data.mcpServers ?? {}), [SERVER_NAME]: { command: launch.command, args: launch.args } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return `Claude Desktop: сервер «${SERVER_NAME}» записан в ${file} — перезапусти приложение`;
}
