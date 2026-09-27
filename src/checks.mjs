/** Проверки подключения к сервисам — для мастера настройки и `ya360-mcp doctor`. Секретов не печатают. */

import { ImapFlow } from 'imapflow';
import { createDAVClient } from 'tsdav';

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: нет ответа за ${ms / 1000} с`)), ms))]);

export async function checkTracker(cfg) {
  const t = cfg.tracker;
  const headers = { Authorization: await t.authorization() };
  if (t.orgId) headers['X-Org-Id'] = t.orgId;
  else headers['X-Cloud-Org-Id'] = t.cloudOrgId;
  const res = await withTimeout(fetch(`${t.api}/myself`, { headers }), 20000, 'Трекер');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = data.errorMessages?.join('; ') || `HTTP ${res.status}`;
    const hint =
      res.status === 401 ? 'токен не принят — проверь его или войди заново'
        : res.status === 403 || res.status === 404 ? 'проверь ID и тип организации (Яндекс 360 или Yandex Cloud)'
          : '';
    throw new Error(`${why}${hint ? ` — ${hint}` : ''}`);
  }
  return `вход как ${data.display || data.login} (${data.login})`;
}

export async function checkMail(cfg) {
  const m = cfg.mail;
  const client = new ImapFlow({ host: m.imapHost, port: 993, secure: true, auth: await m.credentials(), logger: false });
  client.on('error', () => {});
  try {
    await withTimeout(client.connect(), 20000, 'IMAP');
    const box = await client.status('INBOX', { messages: true, unseen: true });
    return `ящик ${m.user}: во «Входящих» ${box.messages}, непрочитанных ${box.unseen}`;
  } catch (err) {
    if (err.authenticationFailed) {
      throw new Error(
        m.auth === 'oauth'
          ? 'IMAP не принял токен — у OAuth-приложения должно быть право mail:imap_full'
          : 'IMAP не принял пароль — нужен пароль приложения типа «Почта», а в настройках почты включены IMAP и «Пароли приложений и OAuth-токены»',
      );
    }
    throw err;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export async function checkCalendar(cfg) {
  const c = cfg.calendar;
  const cr = await c.credentials();
  const auth =
    cr.type === 'oauth'
      ? { credentials: {}, authMethod: 'Custom', authFunction: async () => ({ Authorization: `OAuth ${cr.token}` }) }
      : { credentials: { username: cr.username, password: cr.password }, authMethod: 'Basic' };
  try {
    const client = await withTimeout(createDAVClient({ serverUrl: c.url, defaultAccountType: 'caldav', ...auth }), 20000, 'CalDAV');
    const cals = await client.fetchCalendars();
    const names = cals.filter((x) => !x.components?.length || x.components.includes('VEVENT')).map((x) => x.displayName).filter(Boolean);
    return `календари: ${names.join(', ') || 'нет'}`;
  } catch (err) {
    if (/401|Unauthorized|invalid credentials/i.test(err.message)) {
      throw new Error(cr.type === 'oauth' ? 'CalDAV не принял токен — нужно право calendar:all' : 'CalDAV не принял пароль — нужен пароль приложения типа «Календарь»');
    }
    throw err;
  }
}

export const CHECKS = { tracker: checkTracker, mail: checkMail, calendar: checkCalendar };
export const LABELS = { tracker: 'Трекер', mail: 'Почта', calendar: 'Календарь' };

/** Проверяет готовые сервисы; для неготовых — что не хватает. */
export async function checkAll(cfg, services = Object.keys(CHECKS)) {
  const out = [];
  for (const name of services) {
    const gaps = cfg.missing(name);
    if (gaps.length) {
      out.push({ name, ok: false, skipped: true, detail: `не настроено: ${gaps.join('; ')}` });
      continue;
    }
    try {
      out.push({ name, ok: true, detail: await CHECKS[name](cfg) });
    } catch (err) {
      out.push({ name, ok: false, detail: err.message });
    }
  }
  return out;
}
