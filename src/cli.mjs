/**
 * Консольная утилита: мастер настройки, проверка подключений, вход через Яндекс, перенос из .env,
 * права, подключение к Claude. Значения секретов не печатает никогда.
 */

import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { ROOT, SECRETS, homeDir, readSettings, writeSettings, settingsFile, loadConfig, loadEnvFile } from './config.mjs';
import { secretStore } from './secrets.mjs';
import { deviceLogin, SCOPES } from './oauth.mjs';
import { checkAll, CHECKS, LABELS } from './checks.mjs';
import { GROUPS, PRESETS, parsePermissions } from './permissions.mjs';
import { ask, askSecret, confirm, choose, say } from './prompt.mjs';
import { hasClaudeCode, registerClaudeCode, registerClaudeDesktop, launchCommand } from './register.mjs';

const SERVICES = ['tracker', 'mail', 'calendar'];
const ACCUSATIVE = { tracker: 'Трекер', mail: 'Почту', calendar: 'Календарь' };
const GENITIVE = { tracker: 'Трекера', mail: 'Почты', calendar: 'Календаря' };
const mark = (r) => (r.ok ? '✓' : r.skipped ? '–' : '✗');

function isZone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function openUrl(url) {
  if (!/^https:\/\/[\w.-]+\.(ru|com)\//.test(url)) return;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    // нет браузера — ссылка уже напечатана
  }
}

async function askUntil(question, fallback, valid, hint) {
  for (;;) {
    const v = await ask(question, fallback);
    if (valid(v)) return v;
    say(`  ${hint}`);
  }
}

/** Состояние мастера: настройки в памяти, сохранённые и новые секреты, проверка до записи на диск. */
function session() {
  const home = homeDir();
  const store = secretStore(home);
  const settings = structuredClone(readSettings(home) ?? {});
  settings.account ||= 'default';
  const key = (name) => `${settings.account}:${name}`;
  let existing = {};
  try {
    const raw = store.read(SECRETS.map(key));
    existing = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.slice(settings.account.length + 1), v]));
  } catch (err) {
    say(`! хранилище секретов (${store.name}) недоступно: ${err.message}`);
  }
  const pending = {};
  const cfg = () =>
    loadConfig({ env: { YANDEX_MCP_HOME: home }, legacyPath: null, settings, secrets: { ...existing, ...pending } });
  const save = () => {
    for (const [name, value] of Object.entries(pending)) store.write(key(name), value);
    return writeSettings(home, settings);
  };
  return { home, store, settings, existing, pending, cfg, save };
}

async function verify(ss, service) {
  const cfg = ss.cfg();
  const gaps = cfg.missing(service);
  if (gaps.length) {
    say(`  – ${LABELS[service]}: не хватает: ${gaps.join('; ')}`);
    return false;
  }
  try {
    say(`  ✓ ${LABELS[service]}: ${await CHECKS[service](cfg)}`);
    return true;
  } catch (err) {
    say(`  ✗ ${LABELS[service]}: ${err.message}`);
    return false;
  }
}

/** Секрет с проверкой: спрашиваем, пока вход не пройдёт или человек не откажется. */
async function askVerified(ss, service, secretName, question, { canKeep = false } = {}) {
  for (;;) {
    const value = (await askSecret(question, { keepHint: canKeep || !!ss.existing[secretName] })).replace(/\s+/g, '');
    if (value) ss.pending[secretName] = value;
    else if (!canKeep && !ss.existing[secretName]) {
      say('  значение нужно');
      continue;
    }
    if (await verify(ss, service)) return true;
    if (!(await confirm('Ввести заново?', true))) {
      delete ss.pending[secretName];
      say(`  ${LABELS[service]} останется ненастроенным — вернуться: yandex-mcp setup`);
      return false;
    }
  }
}

const APP_PASSWORD_HELP = {
  mail: [
    'Почта: нужен пароль приложения.',
    '  1. В Почте: Все настройки → Почтовые программы → включи «С сервера imap.yandex.ru по протоколу IMAP»',
    '     и «Пароли приложений и OAuth-токены» (в организации это может быть выключено администратором).',
    '  2. https://id.yandex.ru/security → «Пароли приложений» → тип «Почта». Пароль показывают один раз.',
  ],
  calendar: [
    'Календарь: нужен отдельный пароль приложения — почтовый не подойдёт.',
    '  https://id.yandex.ru/security → «Пароли приложений» → тип «Календарь» (CalDAV).',
  ],
};

async function setupAppPassword(ss, service) {
  ss.settings[service].auth = 'app-password';
  say('');
  APP_PASSWORD_HELP[service].forEach((l) => say(l));
  await askVerified(ss, service, `${service}.password`, `Пароль приложения для ${GENITIVE[service]}`);
}

/** Вход через Яндекс по коду подтверждения — для выбранных сервисов. */
async function oauthLogin(ss, services) {
  const o = (ss.settings.oauth ??= {});
  say('\nВход через Яндекс (OAuth). Нужно своё OAuth-приложение — один раз:');
  say('  1. https://oauth.yandex.ru → «Создать приложение», название любое (например, «Claude»).');
  say(`  2. Отметь права: ${services.flatMap((s) => SCOPES[s]).join(', ')}.`);
  say('  3. Скопируй ClientID и Client secret со страницы приложения.');
  o.clientId = await askUntil('ClientID', o.clientId || '', (v) => /^[0-9a-f]{32}$/i.test(v), 'ClientID — 32 шестнадцатеричных символа');
  const secret = (await askSecret('Client secret', { keepHint: !!ss.existing['oauth.clientSecret'] })).trim();
  if (secret) ss.pending['oauth.clientSecret'] = secret;
  const clientSecret = secret || ss.existing['oauth.clientSecret'];
  if (!clientSecret) throw new Error('без Client secret Яндекс не выдаст токен');

  const tokens = await deviceLogin({
    clientId: o.clientId,
    clientSecret,
    onCode: ({ userCode, url, expiresIn }) => {
      say(`\n  Открой ${url} и введи код  ${userCode}  (действует ${Math.round(expiresIn / 60)} мин). Жду подтверждения…`);
      openUrl(url);
    },
  });
  ss.pending['oauth.tokens'] = JSON.stringify(tokens);
  for (const s of services) ss.settings[s] = { ...ss.settings[s], auth: 'oauth' };
  say('  ✓ вход выполнен');
}

async function setupTracker(ss, oauthDone) {
  const t = ss.settings.tracker;
  // организация может быть задана не в config.json, а в файле с токеном (envFile) — берём действующие значения
  const current = ss.cfg().tracker;
  say('\nТрекер');
  const orgType = await choose('Где организация Трекера?', [
    { value: '360', label: 'Яндекс 360 для бизнеса — ID: admin.yandex.ru → Профиль организации' },
    { value: 'cloud', label: 'Yandex Cloud — ID: console.yandex.cloud → Organization' },
  ], current.cloudOrgId && !current.orgId ? 1 : 0);
  const orgId = await askUntil('ID организации', current.orgId || current.cloudOrgId || '', (v) => /^[\w-]{3,}$/.test(v), 'нужен ID организации');
  if (orgType === '360') {
    t.orgId = orgId;
    delete t.cloudOrgId;
  } else {
    t.cloudOrgId = orgId;
    delete t.orgId;
  }

  if (oauthDone && (await confirm('Входить в Трекер тем же входом через Яндекс?', true))) {
    t.auth = 'oauth';
    await verify(ss, 'tracker');
  } else {
    t.auth = 'token';
    if (t.envFile) say(`  Сейчас токен берётся из файла ${t.envFile} — Enter, чтобы так и оставить.`);
    else say('  Нужен OAuth-токен с правами tracker:read и tracker:write (как получить — README, раздел «Трекер»).');
    const ok = await askVerified(ss, 'tracker', 'tracker.token', 'OAuth-токен Трекера', { canKeep: !!t.envFile });
    if (ok && ss.pending['tracker.token']) delete t.envFile; // ввели свой токен — файл больше не нужен
  }
  t.defaultQueue = (await ask('Очередь по умолчанию — ключ, необязательно', t.defaultQueue || '')) || undefined;
  t.defaultBoard = (await ask('Доска для спринтов по умолчанию — id или название, необязательно', t.defaultBoard || '')) || undefined;
}

async function setupPermissions(ss) {
  say('\nЧто разрешить Claude? Позже можно поменять: yandex-mcp permissions');
  const presets = Object.keys(PRESETS);
  const cur = ss.settings.permissions;
  const options = [...presets.map((p) => ({ value: p, label: `${p} — ${PRESETS[p].title}` })), { value: 'custom', label: 'выбрать группы самому' }];
  const idx = typeof cur === 'string' && presets.includes(cur) ? presets.indexOf(cur) : cur ? options.length - 1 : 0;
  const choice = await choose('Права', options, idx);
  if (choice !== 'custom') {
    ss.settings.permissions = choice;
    return;
  }
  Object.entries(GROUPS).forEach(([g, d]) => say(`  ${g.padEnd(16)} ${d}`));
  for (;;) {
    const spec = await ask('Группы через запятую (можно заготовки и -исключения, например assist,-mail.organize)', Array.isArray(cur) ? cur.join(',') : 'read');
    try {
      parsePermissions(spec);
      ss.settings.permissions = spec.split(',').map((s) => s.trim()).filter(Boolean);
      return;
    } catch (err) {
      say(`  ${err.message}`);
    }
  }
}

async function offerRegister() {
  const launch = launchCommand();
  const run = (fn) => {
    try {
      say(`  ${fn()}`);
    } catch (err) {
      say(`  ✗ ${err.message}`);
    }
  };
  if (hasClaudeCode()) {
    if (await confirm('Подключить сервер к Claude Code (для всех проектов)?', true)) run(() => registerClaudeCode(launch));
  } else say('Claude Code не найден — подключить позже: yandex-mcp register');
  if (await confirm('Подключить к Claude Desktop (вкладка Chat)?', false)) run(() => registerClaudeDesktop(launch));
}

// ───────────────────────────────────────────── команды

async function setup() {
  const ss = session();
  const st = ss.settings;
  say('Настройка yandex-mcp — неофициальный MCP-сервер для Яндекс Трекера, Почты и Календаря.');
  say(`Настройки: ${settingsFile(ss.home)} · секреты: ${ss.store.name}\n`);

  st.login = await askUntil('Адрес ящика Яндекса (полностью, с @)', st.login || '', (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'нужен адрес вида ivan@yandex.ru');
  st.timezone = await askUntil('Часовой пояс', st.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow', isZone, 'нужен пояс вида Europe/Moscow');

  const services = [];
  for (const s of SERVICES) {
    st[s] = { ...(st[s] ?? {}) };
    st[s].enabled = await confirm(`Подключить ${ACCUSATIVE[s]}?`, st[s].enabled !== false);
    if (st[s].enabled) services.push(s);
  }

  const mailCal = services.filter((s) => s !== 'tracker');
  let oauthDone = false;
  if (mailCal.length) {
    const method = await choose('\nКак входить в Почту и Календарь?', [
      { value: 'app-password', label: 'пароли приложений — проще, ничего регистрировать не нужно' },
      { value: 'oauth', label: 'вход через Яндекс (OAuth) — один вход на все сервисы, нужно своё OAuth-приложение' },
    ], mailCal.some((s) => st[s].auth === 'oauth') ? 1 : 0);
    if (method === 'oauth') {
      await oauthLogin(ss, services);
      oauthDone = true;
      for (const s of mailCal) await verify(ss, s);
    } else {
      for (const s of mailCal) await setupAppPassword(ss, s);
    }
  }
  if (st.mail?.enabled) st.mail.fromName = (await ask('Имя отправителя в письмах, необязательно', st.mail.fromName || '')) || undefined;
  if (st.tracker?.enabled) await setupTracker(ss, oauthDone);

  await setupPermissions(ss);
  const file = ss.save();
  say(`\nСохранено: ${file}`);
  await offerRegister();
  say('\nГотово. Проверить подключение в любой момент: yandex-mcp doctor');
  return 0;
}

async function doctor() {
  const cfg = loadConfig();
  const st = cfg.status();
  say(`Настройки: ${st.source}${st.settingsFile ? ` — ${st.settingsFile}` : ''}`);
  say(`Секреты: ${st.secretStore ?? 'только переменные окружения'} · аккаунт: ${st.account} · пояс: ${st.timezone}`);
  say(`Права: ${[...cfg.permissions].join(', ')}`);
  if (st.oauth.loggedIn) say(`Вход через Яндекс: выполнен${st.oauth.expiresAt ? `, токен до ${st.oauth.expiresAt.slice(0, 10)}` : ''}`);
  for (const p of st.problems) say(`! ${p}`);
  const results = await checkAll(cfg);
  for (const r of results) say(`${mark(r)} ${LABELS[r.name]}: ${r.detail}`);
  return results.some((r) => !r.ok && !r.skipped) ? 1 : 0;
}

async function login() {
  const ss = session();
  const st = ss.settings;
  if (!st.login) st.login = await askUntil('Адрес ящика Яндекса (полностью, с @)', '', (v) => /@/.test(v), 'нужен адрес с @');
  const services = [];
  for (const s of SERVICES) {
    if (st[s]?.enabled === false) continue;
    if (await confirm(`Входить через Яндекс в ${ACCUSATIVE[s]}?`, st[s]?.auth === 'oauth' || s !== 'tracker')) {
      st[s] = { ...(st[s] ?? {}), enabled: true };
      services.push(s);
    }
  }
  if (!services.length) return 0;
  await oauthLogin(ss, services);
  for (const s of services) await verify(ss, s);
  say(`Сохранено: ${ss.save()}`);
  return 0;
}

async function logout() {
  const home = homeDir();
  const settings = readSettings(home);
  if (!settings) {
    say('Настроек нет — удалять нечего.');
    return 0;
  }
  const store = secretStore(home);
  if (!(await confirm(`Удалить из хранилища (${store.name}) все пароли и токены yandex-mcp?`, false))) return 0;
  for (const n of SECRETS) store.remove(`${settings.account || 'default'}:${n}`);
  say('Удалено. config.json оставлен; войти заново: yandex-mcp setup');
  return 0;
}

const LEGACY_SECRETS = [
  ['YANDEX_MAIL_APP_PASSWORD', 'mail.password'],
  ['YANDEX_CALENDAR_APP_PASSWORD', 'calendar.password'],
  ['YANDEX_TRACKER_TOKEN', 'tracker.token'],
  ['YANDEX_OAUTH_CLIENT_SECRET', 'oauth.clientSecret'],
];

async function migrate(file = resolve(ROOT, '.env')) {
  const legacy = loadEnvFile(resolve(file));
  if (!legacy) {
    say(`Нет файла ${resolve(file)}`);
    return 1;
  }
  const L = (k) => String(legacy[k] ?? '').trim();
  const ss = session();
  const st = ss.settings;
  if (L('YANDEX_LOGIN')) st.login = L('YANDEX_LOGIN');
  if (L('YANDEX_TZ')) st.timezone = L('YANDEX_TZ');
  st.permissions = L('YANDEX_MCP_PERMISSIONS') || (/^(1|true|yes|да)$/i.test(L('YANDEX_MCP_READONLY')) ? 'read' : st.permissions || 'full');
  st.tracker = { ...st.tracker };
  if (L('YANDEX_TRACKER_ENV_FILE')) st.tracker.envFile = resolve(ROOT, L('YANDEX_TRACKER_ENV_FILE'));
  for (const [k, field] of [['YANDEX_TRACKER_ORG_ID', 'orgId'], ['YANDEX_TRACKER_CLOUD_ORG_ID', 'cloudOrgId'], ['YANDEX_TRACKER_QUEUE', 'defaultQueue'], ['YANDEX_TRACKER_BOARD', 'defaultBoard']]) {
    if (L(k)) st.tracker[field] = L(k);
  }
  st.mail = { ...st.mail, ...(L('YANDEX_MAIL_FROM_NAME') ? { fromName: L('YANDEX_MAIL_FROM_NAME') } : {}), ...(L('YANDEX_MAIL_LOGIN') ? { login: L('YANDEX_MAIL_LOGIN') } : {}) };
  st.calendar = { ...st.calendar, ...(L('YANDEX_CALENDAR_DEFAULT') ? { defaultCalendar: L('YANDEX_CALENDAR_DEFAULT') } : {}), ...(L('YANDEX_CALENDAR_LOGIN') ? { login: L('YANDEX_CALENDAR_LOGIN') } : {}) };
  if (L('YANDEX_OAUTH_CLIENT_ID')) st.oauth = { ...st.oauth, clientId: L('YANDEX_OAUTH_CLIENT_ID') };
  const moved = [];
  for (const [envName, secretName] of LEGACY_SECRETS) {
    if (L(envName)) {
      ss.pending[secretName] = L(envName);
      moved.push(secretName);
    }
  }

  say('Проверяю вход с перенесёнными настройками…');
  const results = await checkAll(ss.cfg());
  for (const r of results) say(`  ${mark(r)} ${LABELS[r.name]}: ${r.detail}`);
  if (results.some((r) => !r.ok && !r.skipped) && !(await confirm('Есть ошибки. Всё равно сохранить?', false))) return 1;

  say(`Сохранено: ${ss.save()}`);
  say(`Секреты перенесены в ${ss.store.name}: ${moved.join(', ') || 'нет'}`);
  if (st.tracker.envFile) say(`Токен Трекера по-прежнему читается из ${st.tracker.envFile}`);
  say(`${resolve(file)} больше не читается — теперь главный config.json.`);
  if (moved.length && (await confirm(`Удалить ${resolve(file)}? Пароли из него теперь в ${ss.store.name}`, true))) {
    unlinkSync(resolve(file));
    say('Удалён.');
  }
  return 0;
}

async function permissions(spec) {
  if (!spec) {
    const cfg = loadConfig();
    say(`Сейчас включено: ${[...cfg.permissions].join(', ')}\n\nЗаготовки:`);
    for (const [p, v] of Object.entries(PRESETS)) say(`  ${p.padEnd(7)} ${v.title}`);
    say('\nГруппы:');
    for (const [g, d] of Object.entries(GROUPS)) say(`  ${g.padEnd(16)} ${d}`);
    say('\nИзменить: yandex-mcp permissions assist   ·   read,tracker.comment   ·   full,-mail.send');
    return 0;
  }
  parsePermissions(spec); // проверка до записи
  const home = homeDir();
  const settings = readSettings(home);
  if (!settings) {
    say('Нет config.json — сначала yandex-mcp setup (или задай переменную YANDEX_MCP_PERMISSIONS).');
    return 1;
  }
  settings.permissions = spec.includes(',') ? spec.split(',').map((s) => s.trim()) : spec;
  writeSettings(home, settings);
  say(`Сохранено: ${[...parsePermissions(settings.permissions)].join(', ')}. Действует с новой сессии Claude.`);
  return 0;
}

async function register(target) {
  const launch = launchCommand();
  say(`Запуск сервера: ${launch.command} ${launch.args.join(' ')}`);
  if (!target || target === 'code') {
    if (!hasClaudeCode()) say('Claude Code не найден (команды claude нет в PATH).');
    else say(registerClaudeCode(launch));
  }
  if (target === 'desktop' || (!target && (await confirm('Подключить и к Claude Desktop (вкладка Chat)?', false)))) {
    say(registerClaudeDesktop(launch));
  }
  return 0;
}

function help() {
  say(`yandex-mcp — неофициальный MCP-сервер для Яндекс Трекера, Почты и Календаря

  yandex-mcp                  запустить сервер (так его запускают Claude Code и Claude Desktop)
  yandex-mcp setup            мастер настройки: вход, проверка, права, подключение к Claude
  yandex-mcp doctor           проверить подключение к сервисам
  yandex-mcp login            войти через Яндекс (OAuth) вместо паролей приложений
  yandex-mcp logout           удалить сохранённые пароли и токены
  yandex-mcp permissions [..] показать или изменить права (read, assist, full, группы)
  yandex-mcp register [code|desktop]  подключить к Claude Code / Claude Desktop
  yandex-mcp migrate [.env]   перенести настройки из прежнего .env

Настройки: ${settingsFile(homeDir())}`);
  return 0;
}

export async function runCli([command, ...rest]) {
  const commands = {
    setup,
    doctor,
    login,
    logout,
    migrate: () => migrate(rest[0]),
    permissions: () => permissions(rest[0]),
    register: () => register(rest[0]),
    help,
    '--help': help,
    '-h': help,
  };
  const fn = commands[command];
  if (!fn) {
    say(`Неизвестная команда «${command}».\n`);
    help();
    return 2;
  }
  try {
    return (await fn()) ?? 0;
  } catch (err) {
    say(`\nОшибка: ${err.message}`);
    return 1;
  }
}
