/** Настройки и хранилище секретов. Запуск: node --test test/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, homeDir, writeSettings } from '../src/config.mjs';
import { secretStore } from '../src/secrets.mjs';
import { normalizeTokens } from '../src/oauth.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'yandex-mcp-test-'));

test('папка настроек для каждой ОС и переопределение', () => {
  assert.equal(homeDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'), join('C:\\Users\\u\\AppData\\Roaming', 'yandex-mcp'));
  assert.match(homeDir({}, 'darwin'), /Library[\\/]Application Support[\\/]yandex-mcp$/);
  assert.equal(homeDir({ XDG_CONFIG_HOME: '/x' }, 'linux'), join('/x', 'yandex-mcp'));
  assert.equal(homeDir({ YANDEX_MCP_HOME: tmpdir() }, 'linux'), tmpdir());
});

test('только переменные окружения: по умолчанию только чтение, недостающее перечислено', () => {
  const home = tmp();
  try {
    const cfg = loadConfig({
      env: { YANDEX_MCP_HOME: home, YANDEX_LOGIN: 'ivan@example.ru', YANDEX_MAIL_APP_PASSWORD: 'x', YANDEX_TZ: 'Asia/Omsk' },
      legacyPath: null,
    });
    assert.equal(cfg.source, 'переменные окружения');
    assert.deepEqual([...cfg.permissions], ['tracker.read', 'mail.read', 'calendar.read']);
    assert.equal(cfg.tz, 'Asia/Omsk');
    assert.deepEqual(cfg.missing('mail'), []);
    assert.match(cfg.missing('calendar').join(), /пароль приложения/);
    assert.equal(cfg.missing('tracker').length, 2);
    const st = cfg.status();
    assert.equal(st.mail.credentialFrom, 'окружение');
    assert.ok(!JSON.stringify(st).includes('"x"'), 'пароль не должен попасть в сводку');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('права из окружения главнее настроек', () => {
  const home = tmp();
  try {
    writeSettings(home, { permissions: 'full' });
    const cfg = loadConfig({ env: { YANDEX_MCP_HOME: home, YANDEX_MCP_PERMISSIONS: 'assist' }, legacyPath: null });
    assert.ok(cfg.permissions.has('mail.draft') && !cfg.permissions.has('mail.send'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config.json и секреты из хранилища ОС', { skip: process.platform !== 'win32' && 'хранилище проверяется на Windows' }, async () => {
  const home = tmp();
  try {
    writeSettings(home, {
      account: 'work',
      login: 'ivan@example.ru',
      timezone: 'Europe/Moscow',
      permissions: ['assist'],
      tracker: { orgId: '123', defaultQueue: 'PROJ', defaultBoard: '7' },
      calendar: { enabled: false },
    });
    const store = secretStore(home);
    store.write('work:mail.password', 'почтовый-пароль');
    store.write('work:tracker.token', 'y0_токен');
    assert.ok(!readFileSync(join(home, 'secrets.json'), 'utf8').includes('почтовый'), 'секрет в файле зашифрован');

    const cfg = loadConfig({ env: { YANDEX_MCP_HOME: home }, legacyPath: null });
    assert.equal(cfg.source, 'config.json');
    assert.equal(cfg.account, 'work');
    assert.deepEqual(cfg.missing('mail'), []);
    assert.deepEqual(cfg.missing('tracker'), []);
    assert.deepEqual(cfg.missing('calendar'), ['выключен в настройках']);
    assert.equal(cfg.tracker.defaultQueue, 'PROJ');
    assert.deepEqual(await cfg.mail.credentials(), { user: 'ivan@example.ru', pass: 'почтовый-пароль' });
    assert.equal(await cfg.tracker.authorization(), 'OAuth y0_токен');
    assert.equal(cfg.status().mail.credentialFrom, 'Windows DPAPI');

    // пароль из окружения главнее сохранённого
    const over = loadConfig({ env: { YANDEX_MCP_HOME: home, YANDEX_MAIL_APP_PASSWORD: 'из-окружения' }, legacyPath: null });
    assert.equal((await over.mail.credentials()).pass, 'из-окружения');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('вход через Яндекс: без входа понятная ошибка, токен из окружения работает', async () => {
  const home = tmp();
  try {
    writeSettings(home, { login: 'ivan@example.ru', mail: { auth: 'oauth' }, tracker: { auth: 'oauth', orgId: '1' } });
    const cfg = loadConfig({ env: { YANDEX_MCP_HOME: home }, legacyPath: null });
    assert.match(cfg.missing('mail').join(), /yandex-mcp login/);
    await assert.rejects(cfg.mail.credentials(), /вход через Яндекс не выполнен/);

    const withToken = loadConfig({ env: { YANDEX_MCP_HOME: home, YANDEX_OAUTH_TOKEN: 'tok' }, legacyPath: null });
    assert.deepEqual(await withToken.mail.credentials(), { user: 'ivan@example.ru', accessToken: 'tok' });
    assert.equal(await withToken.tracker.authorization(), 'OAuth tok');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('секрет с переводом строки не записывается ни в одно хранилище', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.throws(() => secretStore(tmpdir(), platform).write('a:b', 'x\nadd-generic-password -s evil'), /перевода строки/);
  }
});

test('срок жизни токена пересчитывается в момент истечения', () => {
  const t = normalizeTokens({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }, 1000);
  assert.deepEqual(t, { access_token: 'a', refresh_token: 'r', expires_at: 1000 + 3600 * 1000, scope: undefined });
});
