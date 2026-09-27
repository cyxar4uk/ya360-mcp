/**
 * Инструмент yandex_login: подключение аккаунта прямо из чата, без терминала.
 * Сервер открывает страницу Яндекса, человек нажимает «Разрешить», браузер возвращается на 127.0.0.1 —
 * код и токен идут мимо чата. Токен ложится в хранилище ОС, настройки — в config.json, а инструменты
 * подключённых сервисов появляются сразу (activate).
 */

import { existsSync } from 'node:fs';
import { z } from 'zod';
import { defineTool, openUrl } from './util.mjs';
import { browserLogin, scopesFor, yandexProfile, SHARED_CLIENT_ID } from './oauth.mjs';
import { homeDir, readSettings, writeSettings } from './config.mjs';
import { secretStore } from './secrets.mjs';

const SERVICE = z.enum(['tracker', 'mail', 'calendar']);

export function registerLoginTool(server, { activate, legacyEnvPath }) {
  defineTool(server, 'yandex_login', {
    title: 'Яндекс: подключить аккаунт',
    kind: 'write',
    description:
      'Подключить Трекер, Почту и Календарь входом через Яндекс: в браузере откроется страница Яндекса, человек нажимает ' +
      '«Разрешить» (ждём до 3 минут). Пароли и токены в чат не попадают. Вызывай, только когда пользователь просит подключить ' +
      'Яндекс или сервис не настроен (см. yandex_status), и предупреди, что откроется браузер. Для Трекера сначала спроси ' +
      'ID организации: Яндекс 360 — admin.yandex.ru → Профиль организации; Yandex Cloud — console.yandex.cloud → Organization.',
    input: {
      services: z.array(SERVICE).min(1).default(['tracker', 'mail', 'calendar']).describe('Что подключить'),
      tracker_org_id: z.string().optional().describe('ID организации Яндекс 360 (для Трекера)'),
      tracker_cloud_org_id: z.string().optional().describe('ID организации Yandex Cloud (для Трекера)'),
    },
  }, async ({ services, tracker_org_id, tracker_cloud_org_id }) => {
    const home = homeDir();
    const existing = readSettings(home);
    if (!existing && legacyEnvPath && existsSync(legacyEnvPath)) {
      throw new Error('найден прежний .env — сначала перенесите настройки в терминале: ya360-mcp migrate');
    }
    const settings = existing ?? {};
    settings.account ||= 'default';
    const clientId = settings.oauth?.clientId || SHARED_CLIENT_ID;
    if (!clientId) throw new Error('в этой версии нет общего приложения для входа — настройте в терминале: ya360-mcp setup');

    const tokens = await browserLogin({
      clientId,
      scopes: scopesFor(services),
      loginHint: settings.login,
      say: () => {},
      openUrl,
      askCode: async () => '',
      fallback: false,
      timeoutMs: 3 * 60 * 1000,
    });

    const me = await yandexProfile(tokens.access_token).catch(() => null);
    const notes = [];
    if (me?.email && !settings.login) settings.login = me.email;
    else if (me?.email && settings.login.toLowerCase() !== me.email.toLowerCase()) {
      notes.push(`вход выполнен как ${me.email}, а в настройках указан ${settings.login} — поменять: ya360-mcp setup`);
    }
    for (const s of services) settings[s] = { ...(settings[s] ?? {}), enabled: true, auth: 'oauth' };
    if (tracker_org_id) {
      settings.tracker = { ...settings.tracker, orgId: tracker_org_id };
      delete settings.tracker.cloudOrgId;
    } else if (tracker_cloud_org_id) {
      settings.tracker = { ...settings.tracker, cloudOrgId: tracker_cloud_org_id };
      delete settings.tracker.orgId;
    }
    if (services.includes('tracker') && !settings.tracker?.orgId && !settings.tracker?.cloudOrgId) {
      notes.push('для Трекера нужен ID организации — спроси его у пользователя и вызови yandex_login ещё раз с tracker_org_id или tracker_cloud_org_id');
    }

    secretStore(home).write(`${settings.account}:oauth.tokens`, JSON.stringify(tokens));
    writeSettings(home, settings);
    const { added, restart } = activate();
    if (restart.length) notes.push(`${restart.join(', ')} уже были подключены иначе — новый вход заработает после перезапуска сессии`);
    return {
      connected: services,
      email: me?.email ?? settings.login ?? null,
      newTools: added.length ? `подключено: ${added.join(', ')} — инструменты уже доступны` : 'новых инструментов нет',
      ...(notes.length ? { notes } : {}),
    };
  });
}
