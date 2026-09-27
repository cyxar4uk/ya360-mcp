/**
 * Настройки сервера. Откуда берутся значения, по старшинству:
 *   1. переменные окружения (так передают настройки плагин Claude Code и расширение Claude Desktop);
 *   2. config.json в папке настроек пользователя + секреты в хранилище ОС (так настраивает `yandex-mcp setup`);
 *   3. прежний .env рядом с кодом и файл формата .env.tracker (YANDEX_TRACKER_ENV_FILE) — для совместимости.
 * Значения секретов наружу не выдаются никогда: status() показывает только, есть ли они и откуда.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { parsePermissions } from './permissions.mjs';
import { secretStore } from './secrets.mjs';
import { refreshTokens } from './oauth.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 3600 * 1000;

/** Имена секретов в хранилище; полный ключ — `<аккаунт>:<имя>`. */
export const SECRETS = ['tracker.token', 'mail.password', 'calendar.password', 'oauth.clientSecret', 'oauth.tokens'];

export function loadEnvFile(path) {
  if (!path || !existsSync(path)) return null;
  const out = {};
  for (const raw of readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

/** Папка настроек: YANDEX_MCP_HOME или стандартное место для ОС. */
export function homeDir(env = process.env, platform = process.platform) {
  if (env.YANDEX_MCP_HOME) return resolve(env.YANDEX_MCP_HOME);
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'yandex-mcp');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'yandex-mcp');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'yandex-mcp');
}

export const settingsFile = (home) => join(home, 'config.json');

export function readSettings(home) {
  const file = settingsFile(home);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`не читается ${file}: ${err.message}`);
  }
}

export function writeSettings(home, settings) {
  mkdirSync(home, { recursive: true });
  const file = settingsFile(home);
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: 1, ...settings }, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return file;
}

/**
 * Собирает настройки. Секреты из хранилища ОС читаются одним заходом и только если есть config.json
 * и значение не пришло из окружения.
 *   settings — настройки из памяти вместо config.json (мастер проверяет вход до сохранения);
 *   secrets  — секреты из памяти вместо хранилища ОС (имя → значение).
 */
export function loadConfig({ env = process.env, legacyPath = resolve(ROOT, '.env'), settings: given, secrets: givenSecrets } = {}) {
  const home = homeDir(env);
  const settings = given ?? readSettings(home);
  const s = settings ?? {};
  // прежний .env читается, только пока нет config.json — иначе он незаметно перекрывал бы новые настройки
  const legacy = settings ? null : loadEnvFile(legacyPath);
  const get = (name) => String(env[name] ?? legacy?.[name] ?? '').trim();
  const flag = (name) => /^(1|true|yes|да)$/i.test(get(name));
  const problems = [];

  const trackerFilePath = get('YANDEX_TRACKER_ENV_FILE') || s.tracker?.envFile || '';
  let trackerFile = {};
  if (trackerFilePath) {
    trackerFile = loadEnvFile(resolve(ROOT, trackerFilePath)) ?? {};
    if (!Object.keys(trackerFile).length) problems.push(`YANDEX_TRACKER_ENV_FILE указывает на несуществующий или пустой файл: ${trackerFilePath}`);
  }

  const account = get('YANDEX_MCP_ACCOUNT') || s.account || 'default';
  const fromEnv = {
    'tracker.token': get('YANDEX_TRACKER_TOKEN') || trackerFile.TRACKER_TOKEN || '',
    'mail.password': get('YANDEX_MAIL_APP_PASSWORD'),
    'calendar.password': get('YANDEX_CALENDAR_APP_PASSWORD'),
    'oauth.clientSecret': get('YANDEX_OAUTH_CLIENT_SECRET'),
    'oauth.tokens': '',
  };

  const store = settings ? secretStore(home) : null;
  let stored = {};
  if (givenSecrets) stored = { ...givenSecrets };
  else if (store) {
    const wanted = SECRETS.filter((n) => !fromEnv[n]).map((n) => `${account}:${n}`);
    try {
      const raw = store.read(wanted);
      stored = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.slice(account.length + 1), v]));
    } catch (err) {
      problems.push(`хранилище секретов (${store.name}) недоступно: ${err.message}`);
    }
  }
  const secret = (name) => fromEnv[name] || stored[name] || '';
  const secretSource = (name) => (fromEnv[name] ? 'окружение' : stored[name] ? store.name : null);

  // ── OAuth: один токен на все сервисы, продлевается сам
  const oauth = {
    clientId: get('YANDEX_OAUTH_CLIENT_ID') || s.oauth?.clientId || '',
    clientSecret: secret('oauth.clientSecret'),
    staticToken: get('YANDEX_OAUTH_TOKEN'),
    tokens: null,
  };
  if (stored['oauth.tokens']) {
    try {
      oauth.tokens = JSON.parse(stored['oauth.tokens']);
    } catch {
      problems.push('сохранённый токен Яндекса повреждён — войди заново (yandex-mcp login)');
    }
  }
  const oauthReady = () => !!(oauth.staticToken || oauth.tokens?.access_token);
  let refreshing = null;
  async function oauthToken() {
    if (oauth.staticToken) return oauth.staticToken;
    if (!oauth.tokens?.access_token) throw new Error('вход через Яндекс не выполнен — запусти `yandex-mcp login`');
    const t = oauth.tokens;
    const expiring = t.expires_at && t.expires_at - Date.now() < DAY;
    if (expiring && t.refresh_token && oauth.clientId && oauth.clientSecret) {
      refreshing ??= refreshTokens({ clientId: oauth.clientId, clientSecret: oauth.clientSecret, refreshToken: t.refresh_token })
        .then((fresh) => {
          oauth.tokens = fresh;
          store?.write(`${account}:oauth.tokens`, JSON.stringify(fresh));
          return fresh;
        })
        .finally(() => {
          refreshing = null;
        });
      return (await refreshing).access_token;
    }
    if (t.expires_at && t.expires_at < Date.now()) throw new Error('токен Яндекса истёк и не продлевается — войди заново (yandex-mcp login)');
    return t.access_token;
  }

  // ── права: в режиме только-окружения по умолчанию только чтение, в прежнем .env — всё, как было
  const permissionsSpec =
    get('YANDEX_MCP_PERMISSIONS') ||
    s.permissions ||
    (flag('YANDEX_MCP_READONLY') ? 'read' : legacy && !settings ? 'full' : 'read');

  const login = get('YANDEX_LOGIN') || s.login || '';
  const svc = (name) => s[name] ?? {};

  const tracker = {
    enabled: svc('tracker').enabled !== false,
    auth: get('YANDEX_TRACKER_TOKEN') || trackerFile.TRACKER_TOKEN ? 'token' : svc('tracker').auth || 'token',
    token: secret('tracker.token'),
    orgId: get('YANDEX_TRACKER_ORG_ID') || trackerFile.TRACKER_ORG_ID || svc('tracker').orgId || '',
    cloudOrgId: get('YANDEX_TRACKER_CLOUD_ORG_ID') || trackerFile.TRACKER_CLOUD_ORG_ID || svc('tracker').cloudOrgId || '',
    defaultQueue: get('YANDEX_TRACKER_QUEUE') || svc('tracker').defaultQueue || '',
    defaultBoard: get('YANDEX_TRACKER_BOARD') || svc('tracker').defaultBoard || '',
    api: get('YANDEX_TRACKER_API') || 'https://api.tracker.yandex.net/v3',
    ui: get('YANDEX_TRACKER_UI') || 'https://tracker.yandex.ru',
  };
  tracker.authorization = async () => `OAuth ${tracker.auth === 'oauth' ? await oauthToken() : tracker.token}`;

  const mail = {
    enabled: svc('mail').enabled !== false,
    auth: svc('mail').auth || 'app-password',
    user: get('YANDEX_MAIL_LOGIN') || svc('mail').login || login,
    password: secret('mail.password'),
    fromName: get('YANDEX_MAIL_FROM_NAME') || svc('mail').fromName || '',
    imapHost: get('YANDEX_IMAP_HOST') || 'imap.yandex.ru',
    smtpHost: get('YANDEX_SMTP_HOST') || 'smtp.yandex.ru',
  };
  // пароль из окружения главнее выбранного способа входа: так проще перейти с паролей на OAuth и обратно
  if (fromEnv['mail.password']) mail.auth = 'app-password';
  mail.credentials = async () =>
    mail.auth === 'oauth' ? { user: mail.user, accessToken: await oauthToken() } : { user: mail.user, pass: mail.password };

  const calendar = {
    enabled: svc('calendar').enabled !== false,
    auth: svc('calendar').auth || 'app-password',
    user: get('YANDEX_CALENDAR_LOGIN') || svc('calendar').login || login,
    password: secret('calendar.password'),
    url: get('YANDEX_CALDAV_URL') || 'https://caldav.yandex.ru',
    defaultCalendar: get('YANDEX_CALENDAR_DEFAULT') || svc('calendar').defaultCalendar || '',
  };
  if (fromEnv['calendar.password']) calendar.auth = 'app-password';
  calendar.credentials = async () =>
    calendar.auth === 'oauth'
      ? { type: 'oauth', username: calendar.user, token: await oauthToken() }
      : { type: 'password', username: calendar.user, password: calendar.password };

  const config = {
    home,
    source: settings ? 'config.json' : legacy ? '.env рядом с кодом' : 'переменные окружения',
    account,
    tz: get('YANDEX_TZ') || s.timezone || 'Europe/Moscow',
    downloadDir: get('YANDEX_MCP_DOWNLOAD_DIR') || s.downloadDir || join(tmpdir(), 'yandex-mcp'),
    permissions: parsePermissions(permissionsSpec),
    tracker,
    mail,
    calendar,
    oauth,
    oauthToken,
    store,
  };

  const needOauth = (what) => (oauthReady() ? [] : [`вход через Яндекс для ${what} (yandex-mcp login)`]);

  /** Чего не хватает сервису; пустой массив — сервис готов. */
  config.missing = (service) => {
    const out = [];
    if (service === 'tracker') {
      if (!tracker.enabled) return ['выключен в настройках'];
      if (tracker.auth === 'oauth') out.push(...needOauth('Трекера'));
      else if (!tracker.token) out.push('токен Трекера (YANDEX_TRACKER_TOKEN или yandex-mcp setup)');
      if (!tracker.orgId && !tracker.cloudOrgId) out.push('ID организации: YANDEX_TRACKER_ORG_ID (Яндекс 360) или YANDEX_TRACKER_CLOUD_ORG_ID (Yandex Cloud)');
    }
    for (const [name, c, label] of [['mail', mail, 'Почты'], ['calendar', calendar, 'Календаря']]) {
      if (service !== name) continue;
      if (!c.enabled) return ['выключен в настройках'];
      if (!c.user) out.push('адрес ящика (YANDEX_LOGIN), например ivan@yandex.ru');
      if (c.auth === 'oauth') out.push(...needOauth(label));
      else if (!c.password) out.push(`пароль приложения для ${label} (${name === 'mail' ? 'YANDEX_MAIL_APP_PASSWORD' : 'YANDEX_CALENDAR_APP_PASSWORD'} или yandex-mcp setup)`);
    }
    return out;
  };

  /** Сводка без секретов. */
  config.status = () => {
    const svcStatus = (name, extra) => {
      const m = config.missing(name);
      return { enabled: m.length === 0, missing: m, ...extra };
    };
    return {
      source: config.source,
      settingsFile: settings ? settingsFile(home) : null,
      secretStore: store?.name ?? null,
      account,
      timezone: config.tz,
      downloadDir: config.downloadDir,
      tracker: svcStatus('tracker', {
        auth: tracker.auth,
        credentialFrom: tracker.auth === 'oauth' ? null : trackerFilePath && trackerFile.TRACKER_TOKEN ? trackerFilePath : secretSource('tracker.token'),
        org: tracker.orgId ? 'Яндекс 360 (X-Org-Id)' : tracker.cloudOrgId ? 'Yandex Cloud (X-Cloud-Org-Id)' : null,
        defaultQueue: tracker.defaultQueue || null,
        defaultBoard: tracker.defaultBoard || null,
      }),
      mail: svcStatus('mail', { login: mail.user || null, auth: mail.auth, credentialFrom: mail.auth === 'oauth' ? null : secretSource('mail.password') }),
      calendar: svcStatus('calendar', { login: calendar.user || null, auth: calendar.auth, credentialFrom: calendar.auth === 'oauth' ? null : secretSource('calendar.password') }),
      oauth: {
        app: oauth.clientId ? 'задано' : null,
        loggedIn: oauthReady(),
        expiresAt: oauth.tokens?.expires_at ? new Date(oauth.tokens.expires_at).toISOString() : null,
      },
      problems,
    };
  };

  return config;
}
