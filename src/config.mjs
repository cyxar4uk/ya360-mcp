/**
 * Конфиг сервера. Источники по старшинству: переменные окружения → .env рядом с package.json.
 * Трекер может взять токен из готового файла формата .env.tracker (YANDEX_TRACKER_ENV_FILE),
 * чтобы не копировать его в два места.
 *
 * Здесь же — отчёт о том, какие сервисы настроены. Значения секретов наружу не выдаются никогда.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const local = loadEnvFile(resolve(ROOT, '.env')) ?? {};
const get = (name) => (process.env[name] ?? local[name] ?? '').trim();
const flag = (name) => /^(1|true|yes|да)$/i.test(get(name));

const problems = [];

const trackerFilePath = get('YANDEX_TRACKER_ENV_FILE');
let trackerFile = {};
if (trackerFilePath) {
  const loaded = loadEnvFile(resolve(ROOT, trackerFilePath));
  if (loaded) trackerFile = loaded;
  else problems.push(`YANDEX_TRACKER_ENV_FILE указывает на несуществующий файл: ${trackerFilePath}`);
}
const fromTrackerFile = (name) => (trackerFile[name] ?? '').trim();

const login = get('YANDEX_LOGIN');

export const config = {
  readonly: flag('YANDEX_MCP_READONLY'),
  tz: get('YANDEX_TZ') || 'Europe/Moscow',
  downloadDir: get('YANDEX_MCP_DOWNLOAD_DIR') || join(tmpdir(), 'yandex-mcp'),

  tracker: {
    token: get('YANDEX_TRACKER_TOKEN') || fromTrackerFile('TRACKER_TOKEN'),
    orgId: get('YANDEX_TRACKER_ORG_ID') || fromTrackerFile('TRACKER_ORG_ID'),
    cloudOrgId: get('YANDEX_TRACKER_CLOUD_ORG_ID') || fromTrackerFile('TRACKER_CLOUD_ORG_ID'),
    api: get('YANDEX_TRACKER_API') || 'https://api.tracker.yandex.net/v3',
    ui: get('YANDEX_TRACKER_UI') || 'https://tracker.yandex.ru',
  },

  mail: {
    user: get('YANDEX_MAIL_LOGIN') || login,
    password: get('YANDEX_MAIL_APP_PASSWORD'),
    fromName: get('YANDEX_MAIL_FROM_NAME'),
    imapHost: get('YANDEX_IMAP_HOST') || 'imap.yandex.ru',
    smtpHost: get('YANDEX_SMTP_HOST') || 'smtp.yandex.ru',
  },

  calendar: {
    user: get('YANDEX_CALENDAR_LOGIN') || login,
    password: get('YANDEX_CALENDAR_APP_PASSWORD'),
    url: get('YANDEX_CALDAV_URL') || 'https://caldav.yandex.ru',
    defaultCalendar: get('YANDEX_CALENDAR_DEFAULT'),
  },
};

/** Чего не хватает сервису; пустой массив — сервис настроен. */
export function missing(service) {
  const c = config[service];
  const out = [];
  if (service === 'tracker') {
    if (!c.token) out.push('YANDEX_TRACKER_TOKEN (или TRACKER_TOKEN в YANDEX_TRACKER_ENV_FILE)');
    if (!c.orgId && !c.cloudOrgId) out.push('YANDEX_TRACKER_ORG_ID или YANDEX_TRACKER_CLOUD_ORG_ID');
  }
  if (service === 'mail') {
    if (!c.user) out.push('YANDEX_LOGIN (полный адрес, например ivan@yandex.ru)');
    if (!c.password) out.push('YANDEX_MAIL_APP_PASSWORD (пароль приложения типа «Почта»)');
  }
  if (service === 'calendar') {
    if (!c.user) out.push('YANDEX_LOGIN (полный адрес, например ivan@yandex.ru)');
    if (!c.password) out.push('YANDEX_CALENDAR_APP_PASSWORD (пароль приложения типа «Календарь»)');
  }
  return out;
}

/** Сводка без секретов — для yandex_status и для лога при старте. */
export function status() {
  const svc = (name, extra) => {
    const m = missing(name);
    return { enabled: m.length === 0, missing: m, ...extra };
  };
  return {
    readonly: config.readonly,
    timezone: config.tz,
    downloadDir: config.downloadDir,
    tracker: svc('tracker', {
      org: config.tracker.orgId ? 'Яндекс 360 (X-Org-Id)' : config.tracker.cloudOrgId ? 'Yandex Cloud (X-Cloud-Org-Id)' : null,
      tokenSource: get('YANDEX_TRACKER_TOKEN') ? '.env' : trackerFilePath ? trackerFilePath : null,
    }),
    mail: svc('mail', { login: config.mail.user || null, imap: config.mail.imapHost, smtp: config.mail.smtpHost }),
    calendar: svc('calendar', { login: config.calendar.user || null, caldav: config.calendar.url }),
    problems,
  };
}
