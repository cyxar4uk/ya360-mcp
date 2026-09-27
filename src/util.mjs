/** Общие помощники: регистрация инструментов, файлы, текст писем, часовые пояса. */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const asText = (data) => (typeof data === 'string' ? data : JSON.stringify(data, null, 2));

/**
 * Регистрирует инструмент; ошибки превращает в ответ isError, чтобы модель увидела причину,
 * а не обрыв соединения. kind — для подсказок клиенту: 'read' ничего не меняет; 'write' и 'send' только добавляют;
 * 'update' перезаписывает или убирает существующее (правка, перенос в корзину); 'delete' удаляет.
 */
export function defineTool(server, name, { title, description, input = {}, kind = 'read' }, handler) {
  const annotations = {
    title,
    readOnlyHint: kind === 'read',
    destructiveHint: kind === 'update' || kind === 'delete',
    openWorldHint: true,
  };
  server.registerTool(name, { title, description, inputSchema: input, annotations }, async (args) => {
    try {
      return { content: [{ type: 'text', text: asText(await handler(args ?? {})) }] };
    } catch (err) {
      // imapflow кладёт ответ сервера в responseText, nodemailer — в response
      const detail = err?.responseText || err?.response;
      const message = detail && !String(err.message).includes(detail) ? `${err.message}: ${detail}` : err?.message ?? String(err);
      return { isError: true, content: [{ type: 'text', text: `Ошибка: ${message}` }] };
    }
  });
}

/** Открыть в браузере только https-адрес Яндекса. Без оболочки: & и ? в ссылке не станут командами. */
export function openUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== 'https:' || !/(^|\.)(ya|yandex)\.(ru|com)$/i.test(u.hostname)) return;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', u.href]]
      : process.platform === 'darwin'
        ? ['open', [u.href]]
        : ['xdg-open', [u.href]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    // нет браузера — ссылка уже напечатана
  }
}

// ───────────────────────────────────────────── файлы

/**
 * Сохраняет присланный извне файл только в папку загрузок сервера: чужой файл не должен попасть,
 * например, в автозагрузку. Имя очищается, существующие файлы не перезаписываются.
 */
export function saveDownload(dir, filename, data) {
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  const safe = basename(filename || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
  const ext = extname(safe);
  let file = join(target, safe);
  for (let n = 1; existsSync(file); n++) file = join(target, `${safe.slice(0, safe.length - ext.length)} (${n})${ext}`);
  writeFileSync(file, data);
  return file;
}

/** Локальный файл для отправки наружу: скрытые файлы и папки (.env, .ssh, .git…) не уходят. */
export function localFile(p) {
  const full = resolve(p);
  if (full.split(/[\\/]/).some((part) => part.startsWith('.') && part !== '.' && part !== '..')) {
    throw new Error(`не отправляю скрытые файлы и файлы из скрытых папок: ${full}`);
  }
  if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`нет файла ${full}`);
  return full;
}

export function truncate(text, max) {
  if (!text) return { text: '', truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…[обрезано: ещё ${text.length - max} символов]`, truncated: true };
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', mdash: '—', ndash: '–' };

/** Грубое, но достаточное превращение HTML письма в текст. */
export function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ───────────────────────────────────────────── часовые пояса (без внешних библиотек)

const partsCache = new Map();
function wallParts(date, tz) {
  let fmt = partsCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsCache.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

function offsetMs(date, tz) {
  const w = wallParts(date, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(date.getTime() / 1000) * 1000;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Разбирает дату/время, введённые человеком. Без смещения — время в поясе tz.
 * Возвращает { date: Date, dateOnly: boolean }.
 */
export function parseUserTime(value, tz) {
  const s = String(value).trim();
  const m = LOCAL_RE.exec(s);
  if (!m) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`не понимаю дату «${value}»: нужен формат 2026-09-28 или 2026-09-28T10:00`);
    return { date: d, dateOnly: false };
  }
  const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
  let utc = guess - offsetMs(new Date(guess), tz);
  const second = offsetMs(new Date(utc), tz);
  if (guess - second !== utc) utc = guess - second; // переход на летнее/зимнее время
  return { date: new Date(utc), dateOnly: m[4] === undefined };
}

const pad = (n) => String(n).padStart(2, '0');

/** «2026-09-28 10:00» в поясе tz. */
export function formatInTz(date, tz, { dateOnly = false } = {}) {
  const w = wallParts(date, tz);
  const day = `${w.y}-${pad(w.m)}-${pad(w.d)}`;
  return dateOnly ? day : `${day} ${pad(w.h)}:${pad(w.mi)}`;
}

/** Начало суток (00:00 в поясе tz) для данного момента. */
export function startOfDay(date, tz) {
  const w = wallParts(date, tz);
  return parseUserTime(`${w.y}-${pad(w.m)}-${pad(w.d)}`, tz).date;
}
