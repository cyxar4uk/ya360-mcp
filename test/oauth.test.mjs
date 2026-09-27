/** Вход через Яндекс: PKCE, локальный адрес возврата, ручной код. Сеть к Яндексу подменена. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pkcePair, authorizeUrl, browserLogin, scopesFor, LOOPBACK_REDIRECT, MANUAL_REDIRECT } from '../src/oauth.mjs';

const realFetch = globalThis.fetch;

/** Подменяет обмен кода на токен; возвращает, что пришло в Яндекс. */
function fakeYandex() {
  const seen = {};
  globalThis.fetch = async (url, opts) => {
    if (String(url) === 'https://oauth.yandex.ru/token') {
      Object.assign(seen, Object.fromEntries(new URLSearchParams(opts.body)), { authorization: opts.headers?.Authorization });
      return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  return seen;
}

test('PKCE: верификатор нужной длины, challenge — SHA-256 от него', () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(pkcePair().verifier, verifier);
});

test('ссылка авторизации: код, PKCE S256, state, права', () => {
  const u = new URL(authorizeUrl({ clientId: 'cid', redirectUri: LOOPBACK_REDIRECT, challenge: 'ch', state: 'st', scopes: ['a:b', 'c:d'] }));
  assert.equal(u.origin + u.pathname, 'https://oauth.yandex.ru/authorize');
  const p = Object.fromEntries(u.searchParams);
  assert.deepEqual(p, { response_type: 'code', client_id: 'cid', redirect_uri: LOOPBACK_REDIRECT, code_challenge: 'ch', code_challenge_method: 'S256', state: 'st', scope: 'a:b c:d' });
});

test('права запрашиваются только для выбранных сервисов', () => {
  assert.deepEqual(scopesFor(['tracker']), ['tracker:read', 'tracker:write']);
  assert.equal(scopesFor(['tracker', 'mail', 'calendar']).length, 5, 'не больше пяти прав — лимит приложения Яндекса');
  assert.ok(scopesFor(['mail', 'calendar']).includes('mail:smtp'));
  assert.ok(!scopesFor(['mail']).includes('tracker:write'));
});

test('локальный адрес: чужой state отвергается, верный — код обменивается без секрета', async () => {
  const seen = fakeYandex();
  try {
    const tokens = await browserLogin({
      clientId: 'cid',
      scopes: ['tracker:read'],
      say: () => {},
      askCode: async () => {
        throw new Error('ручной код не должен понадобиться');
      },
      openUrl: async (url) => {
        const p = new URL(url).searchParams;
        const bad = await realFetch(`${p.get('redirect_uri')}?code=evil&state=wrong`);
        assert.equal(bad.status, 400);
        await realFetch(`${p.get('redirect_uri')}?code=CODE1&state=${p.get('state')}`);
      },
    });
    assert.equal(tokens.access_token, 'A');
    assert.equal(tokens.refresh_token, 'R');
    assert.equal(seen.grant_type, 'authorization_code');
    assert.equal(seen.code, 'CODE1');
    assert.equal(seen.client_id, 'cid');
    assert.ok(seen.code_verifier?.length >= 43);
    assert.ok(!seen.client_secret && !seen.authorization, 'секрет приложения не отправляется');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('отказ на странице Яндекса — понятная ошибка', async () => {
  fakeYandex();
  try {
    await assert.rejects(
      browserLogin({
        clientId: 'cid',
        say: () => {},
        askCode: async () => '',
        openUrl: async (url) => {
          const p = new URL(url).searchParams;
          await realFetch(`${p.get('redirect_uri')}?error=access_denied&state=${p.get('state')}`);
        },
      }),
      /не разрешён/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('у приложения нет части прав — повторный вход без списка прав', async () => {
  const seen = fakeYandex();
  const urls = [];
  try {
    const tokens = await browserLogin({
      clientId: 'cid',
      scopes: ['tracker:read', 'login:info'],
      say: () => {},
      askCode: async () => '',
      openUrl: async (url) => {
        urls.push(url);
        const p = new URL(url).searchParams;
        const answer = urls.length === 1
          ? `error=invalid_scope&error_description=${encodeURIComponent('Запрашиваемые доступы отсутствуют у данного приложения')}`
          : 'code=CODE3';
        await realFetch(`${p.get('redirect_uri')}?${answer}&state=${p.get('state')}`);
      },
    });
    assert.equal(urls.length, 2);
    assert.ok(new URL(urls[0]).searchParams.has('scope'));
    assert.ok(!new URL(urls[1]).searchParams.has('scope'), 'повтор — без списка прав');
    assert.equal(seen.code, 'CODE3');
    assert.equal(tokens.access_token, 'A');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ручной путь: ссылка на страницу с кодом, код из консоли', async () => {
  const seen = fakeYandex();
  let opened;
  try {
    const tokens = await browserLogin({
      clientId: 'cid',
      manual: true,
      say: () => {},
      openUrl: (url) => (opened = url),
      askCode: async () => '  CODE2  ',
    });
    assert.equal(new URL(opened).searchParams.get('redirect_uri'), MANUAL_REDIRECT);
    assert.equal(seen.code, 'CODE2');
    assert.equal(tokens.access_token, 'A');
  } finally {
    globalThis.fetch = realFetch;
  }
});
