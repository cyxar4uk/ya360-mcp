/**
 * Вход через Яндекс ID по коду подтверждения (device flow) и продление токена.
 * Нужно своё OAuth-приложение на oauth.yandex.ru: client_id и client_secret (секрет Яндекс требует при выдаче токена).
 * https://yandex.ru/dev/id/doc/ru/codes/screen-code-oauth
 */

const OAUTH = 'https://oauth.yandex.ru';

/** Права приложения по сервисам — их отмечают при регистрации приложения. */
export const SCOPES = {
  tracker: ['tracker:read', 'tracker:write'],
  mail: ['mail:imap_full', 'mail:smtp'],
  calendar: ['calendar:all'],
};

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

/** Новый токен по refresh_token. */
export async function refreshTokens({ clientId, clientSecret, refreshToken }) {
  const r = await post('/token', { grant_type: 'refresh_token', refresh_token: refreshToken }, { clientId, clientSecret });
  if (!r.ok) throw new Error(`не удалось продлить токен Яндекса: ${describe(r)} — войди заново (ya360-mcp login)`);
  const tokens = normalizeTokens(r.data);
  if (!tokens.refresh_token) tokens.refresh_token = refreshToken;
  return tokens;
}
