/**
 * Хранилище секретов в средствах самой ОС — без нативных модулей, чтобы сервер собирался в один файл:
 *   Windows — DPAPI (шифрование под учётной записью пользователя) через PowerShell, файл secrets.json в папке настроек;
 *   macOS   — Связка ключей через `security`;
 *   Linux   — Secret Service через `secret-tool` (пакет libsecret-tools).
 * Значения секретов никогда не попадают в аргументы командной строки — только в stdin дочернего процесса.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SERVICE = 'ya360-mcp';

function run(cmd, args, input) {
  const res = spawnSync(cmd, args, { input, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (res.error) {
    if (res.error.code === 'ENOENT') throw new Error(`нет программы ${cmd}`);
    throw res.error;
  }
  return res;
}

// ───────────────────────────────────────────── Windows: DPAPI

/**
 * Сценарий одной строкой (так его надёжно исполняет `-Command -`), данные — base64 внутри него.
 * Весь текст идёт через stdin: без -EncodedCommand и -ExecutionPolicy, на которые реагируют корпоративные антивирусы.
 */
const PS_DPAPI = (method, payload) =>
  [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    `$items = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${SERVICE}')`,
    '$out = New-Object System.Collections.ArrayList',
    `foreach ($s in @($items)) { $bytes = [Convert]::FromBase64String([string]$s); $res = [Security.Cryptography.ProtectedData]::${method}($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser); [void]$out.Add([Convert]::ToBase64String($res)) }`,
    '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($out) -Compress))))',
  ].join('; ');

/** Один вызов PowerShell на пачку значений: base64 на входе и выходе, чтобы не зависеть от кодировки консоли. */
function dpapi(method, values) {
  if (!values.length) return [];
  const payload = Buffer.from(JSON.stringify(values)).toString('base64');
  const res = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], `${PS_DPAPI(method, payload)}\n`);
  if (res.status !== 0) throw new Error(`DPAPI (${method}) не сработал: ${(res.stderr || '').trim().split('\n')[0]}`);
  const out = JSON.parse(Buffer.from(res.stdout.trim(), 'base64').toString('utf8'));
  return Array.isArray(out) ? out : [out];
}

function windowsStore(dir) {
  const file = join(dir, 'secrets.json');
  const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const save = (data) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  return {
    name: 'Windows DPAPI',
    read(keys) {
      const data = load();
      const present = keys.filter((k) => data[k]);
      const plain = dpapi('Unprotect', present.map((k) => data[k]));
      return Object.fromEntries(present.map((k, i) => [k, Buffer.from(plain[i], 'base64').toString('utf8')]));
    },
    write(key, value) {
      const data = load();
      [data[key]] = dpapi('Protect', [b64(value)]);
      save(data);
    },
    remove(key) {
      const data = load();
      delete data[key];
      save(data);
    },
  };
}

// ───────────────────────────────────────────── macOS: Связка ключей

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// В Связке ключей и Secret Service значение лежит как «b64:…»: JSON с токенами и любые символы
// не зависят от правил кавычек `security -i` и от переводов строк в выводе.
const pack = (value) => `b64:${Buffer.from(value, 'utf8').toString('base64')}`;
const unpack = (stored) => (stored.startsWith('b64:') ? Buffer.from(stored.slice(4), 'base64').toString('utf8') : stored);

function macStore() {
  return {
    name: 'Связка ключей macOS',
    read(keys) {
      const out = {};
      for (const k of keys) {
        const res = run('security', ['find-generic-password', '-s', SERVICE, '-a', k, '-w']);
        if (res.status === 0) out[k] = unpack(res.stdout.replace(/\n$/, ''));
      }
      return out;
    },
    write(key, value) {
      // `security -i` читает команду из stdin — пароль не виден в списке процессов
      const res = run('security', ['-i'], `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(key)} -w ${quote(pack(value))}\n`);
      if (res.status !== 0) throw new Error(`Связка ключей: ${(res.stderr || '').trim()}`);
    },
    remove(key) {
      run('security', ['delete-generic-password', '-s', SERVICE, '-a', key]);
    },
  };
}

// ───────────────────────────────────────────── Linux: Secret Service

function linuxStore() {
  return {
    name: 'Secret Service (secret-tool)',
    read(keys) {
      const out = {};
      for (const k of keys) {
        const res = run('secret-tool', ['lookup', 'service', SERVICE, 'key', k]);
        if (res.status === 0 && res.stdout) out[k] = unpack(res.stdout.replace(/\n$/, ''));
      }
      return out;
    },
    write(key, value) {
      const res = run('secret-tool', ['store', '--label', `${SERVICE}: ${key}`, 'service', SERVICE, 'key', key], pack(value));
      if (res.status !== 0) throw new Error(`secret-tool: ${(res.stderr || '').trim() || 'не удалось сохранить'} — нужен запущенный Secret Service (GNOME Keyring, KWallet)`);
    },
    remove(key) {
      run('secret-tool', ['clear', 'service', SERVICE, 'key', key]);
    },
  };
}

/** Хранилище для текущей ОС. dir — папка настроек (нужна только Windows). */
export function secretStore(dir, platform = process.platform) {
  const store = platform === 'win32' ? windowsStore(dir) : platform === 'darwin' ? macStore() : linuxStore();
  const write = store.write;
  // перевод строки в значении в `security -i` стал бы отдельной командой — такие значения не принимаем нигде
  store.write = (key, value) => {
    if (/[\r\n]/.test(key) || /[\r\n]/.test(String(value))) throw new Error('в секрете не может быть перевода строки');
    return write.call(store, key, String(value));
  };
  return store;
}
