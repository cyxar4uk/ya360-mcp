/**
 * Вход через Яндекс ID.
 *
 * Основной путь — общее приложение проекта: код авторизации с PKCE (RFC 7636). Секрет приложения не нужен
 * («Если … передается параметр code_verifier, то секретный ключ передавать не требуется» — документация Яндекс ID),
 * поэтому в коде только открытый идентификатор приложения. Браузер возвращается на локальный адрес 127.0.0.1,
 * код забирается сам; если локальный адрес недоступен — страница Яндекса показывает код, его вставляют в консоль.
 * https://yandex.ru/dev/id/doc/ru/codes/code-url
 *
 * Запасной путь — своё приложение с секретом и вход по коду подтверждения (device flow).
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const OAUTH = 'https://oauth.yandex.ru';

/**
 * Общее приложение проекта «ya360-mcp» на oauth.yandex.ru. Идентификатор открытый — это не секрет.
 * YANDEX_OAUTH_CLIENT_ID или своё приложение в настройках главнее.
 */
export const SHARED_CLIENT_ID = 'c3382d8fe79c46919620012a38a6b199';

/** Адреса возврата, прописанные в общем приложении. */
export const LOOPBACK_PORT = 51734;
export const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;
export const MANUAL_REDIRECT = 'https://oauth.yandex.ru/verification_code';

/** Права по сервисам. login:email — чтобы мастер сам узнал адрес ящика. */
export const SCOPES = {
  tracker: ['tracker:read', 'tracker:write'],
  mail: ['mail:imap_full', 'mail:smtp'],
  calendar: ['calendar:all'],
  profile: ['login:email', 'login:info'],
};

export const scopesFor = (services) => [...new Set([...services.flatMap((s) => SCOPES[s] ?? []), ...SCOPES.profile])];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, params, { clientId, clientSecret } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  const res = await fetch(`${OAUTH}${path}`, { method: 'POST', headers, body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const describe = (r) => r.data.error_description || r.data.error || `HTTP ${r.status}`;

/** Ответ Яндекса → то, что храним: срок жизни пересчитан в момент истечения. */
export function normalizeTokens(data, now = Date.now()) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? now + Number(data.expires_in) * 1000 : null,
    scope: data.scope,
  };
}

// ───────────────────────────────────────────── код авторизации + PKCE

/** Одноразовая пара PKCE: verifier остаётся у нас, challenge уходит в ссылку. */
export function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizeUrl({ clientId, redirectUri, challenge, state, scopes, loginHint }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  if (scopes?.length) q.set('scope', scopes.join(' '));
  if (loginHint) q.set('login_hint', loginHint);
  return `${OAUTH}/authorize?${q}`;
}

export async function exchangeCode({ clientId, code, verifier }) {
  const r = await post('/token', { grant_type: 'authorization_code', code: code.trim(), client_id: clientId, code_verifier: verifier });
  if (!r.ok) throw new Error(`Яндекс не выдал токен: ${describe(r)}`);
  return normalizeTokens(r.data);
}

const page = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  '<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222">' +
  `<h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Локальный сервер на 127.0.0.1 ждёт возврата браузера. Возвращает { wait, close } или null, если порт занят.
 * wait() → { code } | { error, description } | { timeout: true }.
 */
async function loopback(state, timeoutMs) {
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  const server = createServer((req, res) => {
    const url = new URL(req.url, LOOPBACK_REDIRECT);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const send = (status, title, text) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(page(title, text));
    };
    // чужой или повторный запрос (другая вкладка, подделка) не должен закончить вход
    if (url.searchParams.get('state') !== state) {
      send(400, 'Неверный запрос', 'Ссылка не от этого входа. Запустите вход заново в консоли.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') || error;
      send(400, 'Вход не выполнен', `Яндекс ответил: ${escapeHtml(description)}. Вернитесь в консоль.`);
      finish({ error, description });
      return;
    }
    send(200, 'Готово', 'Вход через Яндекс выполнен — окно можно закрыть и вернуться в консоль.');
    finish({ code: url.searchParams.get('code') ?? '' });
  });
  const listening = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(LOOPBACK_PORT, '127.0.0.1', () => resolve(true));
  });
  if (!listening) return null;
  const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
  return {
    wait: () => done,
    close: () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    },
  };
}

/**
 * Вход в браузере через общее (или своё, с прописанными адресами возврата) приложение.
 *   say(text) — сообщение человеку; openUrl(url) — открыть браузер; askCode() — спросить код (ручной путь).
 *   manual — сразу ручной путь (нет браузера на этой машине, SSH);
 *   fallback — можно ли перейти на ручной код, если браузер не вернулся (из чата — нельзя: некому вставить код).
 */
export async function browserLogin({ clientId, scopes, loginHint, say, openUrl, askCode, manual = false, fallback = true, timeoutMs = 5 * 60 * 1000 }) {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('hex');

  const server = manual ? null : await loopback(state, timeoutMs);
  if (server) {
    const url = authorizeUrl({ clientId, redirectUri: LOOPBACK_REDIRECT, challenge, state, scopes, loginHint });
    say('Открываю страницу Яндекса — проверьте аккаунт и нажмите «Разрешить».');
    say(`Если браузер не открылся, откройте ссылку сами:\n  ${url}`);
    openUrl(url);
    const result = await server.wait();
    server.close();
    if (result.code) return exchangeCode({ clientId, code: result.code, verifier });
    if (result.error === 'access_denied') throw new Error('доступ не разрешён на странице Яндекса');
    if (!fallback) throw new Error(result.error ? `Яндекс ответил: ${result.description}` : 'не дождался подтверждения в браузере');
    if (result.error) say(`Яндекс ответил: ${result.description}. Попробуем с кодом вручную.`);
    else say('Не дождался возврата из браузера. Попробуем с кодом вручную.');
  } else if (!manual) {
    if (!fallback) throw new Error(`порт ${LOOPBACK_PORT} занят — войдите в терминале: ya360-mcp login --manual`);
    say(`Порт ${LOOPBACK_PORT} занят — вход с кодом вручную.`);
  }

  // ручной путь: Яндекс покажет код на своей странице
  const url = authorizeUrl({ clientId, redirectUri: MANUAL_REDIRECT, challenge, state, scopes, loginHint });
  say(`Откройте ссылку, нажмите «Разрешить» и скопируйте код со страницы Яндекса:\n  ${url}`);
  openUrl(url);
  const code = await askCode();
  if (!code) throw new Error('код не введён');
  return exchangeCode({ clientId, code, verifier });
}

/** Адрес ящика и имя из Яндекс ID (право login:email / login:info). null — если прав нет. */
export async function yandexProfile(accessToken) {
  const res = await fetch('https://login.yandex.ru/info?format=json', { headers: { Authorization: `OAuth ${accessToken}` } });
  if (!res.ok) return null;
  const d = await res.json().catch(() => null);
  if (!d) return null;
  return { email: d.default_email || null, login: d.login || null, name: d.real_name || d.display_name || null };
}

// ───────────────────────────────────────────── своё приложение: код подтверждения (device flow)

/**
 * Вход по коду: onCode({ userCode, url, expiresIn }) показывает код человеку,
 * дальше опрашиваем Яндекс, пока человек не подтвердит вход (или не истечёт код).
 */
export async function deviceLogin({ clientId, clientSecret, scopes, deviceName = 'ya360-mcp', onCode }) {
  const start = await post('/device/code', {
    client_id: clientId,
    device_name: deviceName,
    ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
  });
  if (!start.ok) throw new Error(`Яндекс не выдал код подтверждения: ${describe(start)}`);
  const { device_code, user_code, verification_url, interval = 5, expires_in = 600 } = start.data;
  await onCode({ userCode: user_code, url: verification_url || 'https://ya.ru/device', expiresIn: expires_in });

  const deadline = Date.now() + expires_in * 1000;
  let wait = Number(interval) || 5;
  while (Date.now() < deadline) {
    await sleep(wait * 1000);
    const r = await post('/token', { grant_type: 'device_code', code: device_code }, { clientId, clientSecret });
    if (r.ok) return normalizeTokens(r.data);
    if (r.data.error === 'authorization_pending') continue;
    if (r.data.error === 'slow_down') {
      wait += 5;
      continue;
    }
    throw new Error(`вход не удался: ${describe(r)}`);
  }
  throw new Error('код подтверждения истёк — запусти вход заново');
}

/** Новый токен по refresh_token. Без секрета (общее приложение с PKCE) — только с client_id. */
export async function refreshTokens({ clientId, clientSecret, refreshToken }) {
  const params = { grant_type: 'refresh_token', refresh_token: refreshToken, ...(clientSecret ? {} : { client_id: clientId }) };
  const r = await post('/token', params, { clientId, clientSecret });
  if (!r.ok) throw new Error(`не удалось продлить токен Яндекса: ${describe(r)} — войди заново (ya360-mcp login)`);
  const tokens = normalizeTokens(r.data);
  if (!tokens.refresh_token) tokens.refresh_token = refreshToken;
  return tokens;
}
