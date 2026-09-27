/** Трекер: учёт времени (worklog). */

import { z } from 'zod';
import { defineTool, parseUserTime, formatInTz } from './util.mjs';

// Трекер по умолчанию считает рабочий день 8 часами, неделю — 5 днями
const HOURS_PER_DAY = 8;
const DAYS_PER_WEEK = 5;

const ISO_DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const UNITS = [
  ['w', /^(w|н|нед|недел[ьяи])$/i],
  ['d', /^(d|д|дн|дн[яей]*|день)$/i],
  ['h', /^(h|ч|час|час[аов]*)$/i],
  ['m', /^(m|м|мин|минут[аы]?)$/i],
];

/** «1ч 30м», «2h», «1д 4ч», «1.5ч», «90 мин» или ISO «PT1H30M» → ISO-длительность Трекера. */
export function parseDuration(input) {
  const s = String(input).trim();
  if (ISO_DURATION.test(s.toUpperCase()) && /\d/.test(s) && !/T$/i.test(s)) return s.toUpperCase();
  const parts = { w: 0, d: 0, h: 0, m: 0 };
  const re = /(\d+(?:[.,]\d+)?)\s*([a-zа-яё]+)/gi;
  let matched = '';
  for (let x; (x = re.exec(s)); ) {
    const unit = UNITS.find(([, r]) => r.test(x[2]))?.[0];
    if (!unit) throw new Error(`не понимаю единицу «${x[2]}» в «${input}»: пиши 1н, 2д, 3ч, 30м`);
    parts[unit] += Number(x[1].replace(',', '.'));
    matched += x[0];
  }
  if (!matched || s.replace(/\s+/g, '') !== matched.replace(/\s+/g, '')) {
    throw new Error(`не понимаю длительность «${input}»: пиши «1ч 30м», «2д» или PT1H30M`);
  }
  if (!Number.isInteger(parts.w) || !Number.isInteger(parts.d)) throw new Error('недели и дни — только целые; дробное пиши в часах');
  const minutes = Math.round(parts.h * 60 + parts.m);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!parts.w && !parts.d && !minutes) throw new Error('длительность должна быть больше нуля');
  const time = h || m ? `T${h ? `${h}H` : ''}${m ? `${m}M` : ''}` : '';
  return `P${parts.w ? `${parts.w}W` : ''}${parts.d ? `${parts.d}D` : ''}${time}`;
}

/** ISO-длительность → часы по правилам Трекера (день 8 ч, неделя 5 дней). */
export function durationHours(iso) {
  const x = ISO_DURATION.exec(String(iso ?? ''));
  if (!x) return undefined;
  const [, w = 0, d = 0, h = 0, m = 0, s = 0] = x.map((v) => Number(v ?? 0));
  const hours = (w * DAYS_PER_WEEK + d) * HOURS_PER_DAY + h + m / 60 + s / 3600;
  return Math.round(hours * 100) / 100;
}

/** Время для API Трекера: 2026-09-27T10:00:00.000+0000. */
const trackerTime = (date) => date.toISOString().replace('Z', '+0000');

export function registerTrackerWorklog({ server, config, api, enc, ref, key }) {
  const tz = config.tz;
  const entry = (w) => ({
    id: w.id,
    author: ref(w.createdBy),
    start: w.start ? formatInTz(new Date(w.start), tz) : undefined,
    duration: w.duration,
    hours: durationHours(w.duration),
    comment: w.comment || undefined,
  });
  const sum = (list) => Math.round(list.reduce((a, w) => a + (durationHours(w.duration) ?? 0), 0) * 100) / 100;
  const worklogId = z.union([z.string(), z.number()]).describe('id записи из tracker_get_worklog');

  defineTool(server, 'tracker_get_worklog', {
    title: 'Трекер: списанное время',
    description: `Записи учёта времени по задаче и сумма в часах (день = ${HOURS_PER_DAY} ч, неделя = ${DAYS_PER_WEEK} дней).`,
    input: { key },
  }, async ({ key: k }) => {
    const list = await api('GET', `/issues/${enc(k)}/worklog`);
    return { key: k, totalHours: sum(list), entries: list.map(entry) };
  });

  defineTool(server, 'tracker_search_worklog', {
    title: 'Трекер: списания за период',
    description:
      'Списания времени человека за период по всем задачам, с суммой по задачам. ' +
      'Период — по дате внесения записи. По умолчанию — свои списания за последние 7 дней.',
    input: {
      user: z.string().optional().describe('Логин; по умолчанию текущий пользователь'),
      from: z.string().optional().describe('С даты, например 2026-09-22'),
      to: z.string().optional().describe('По дату (не включая); по умолчанию сейчас'),
    },
  }, async ({ user, from, to }) => {
    const login = user || (await api('GET', '/myself')).login;
    const end = to ? parseUserTime(to, tz).date : new Date();
    const start = from ? parseUserTime(from, tz).date : new Date(end.getTime() - 7 * 24 * 3600 * 1000);
    const list = await api('POST', '/worklog/_search?perPage=1000', {
      createdBy: login,
      createdAt: { from: trackerTime(start), to: trackerTime(end) },
    });
    const byIssue = new Map();
    for (const w of list) {
      const k = w.issue?.key ?? '?';
      if (!byIssue.has(k)) byIssue.set(k, { key: k, summary: w.issue?.display, entries: [] });
      byIssue.get(k).entries.push(w);
    }
    return {
      user: login,
      from: formatInTz(start, tz),
      to: formatInTz(end, tz),
      totalHours: sum(list),
      issues: [...byIssue.values()].map((x) => ({ key: x.key, summary: x.summary, hours: sum(x.entries), entries: x.entries.map(entry) })),
    };
  });

  defineTool(server, 'tracker_add_worklog', {
    title: 'Трекер: списать время',
    kind: 'write',
    description: 'Списать время на задачу. duration — «1ч 30м», «2h», «1д» или PT1H30M; start — когда начали (по умолчанию сейчас).',
    input: {
      key,
      duration: z.string(),
      start: z.string().optional().describe(`Начало работы: 2026-09-27T10:00 (пояс ${tz})`),
      comment: z.string().optional(),
    },
  }, async ({ key: k, duration, start, comment }) => {
    const body = {
      start: trackerTime(start ? parseUserTime(start, tz).date : new Date()),
      duration: parseDuration(duration),
      ...(comment ? { comment } : {}),
    };
    return entry(await api('POST', `/issues/${enc(k)}/worklog`, body));
  });

  defineTool(server, 'tracker_update_worklog', {
    title: 'Трекер: исправить списание',
    kind: 'update',
    description: 'Изменить длительность и/или комментарий записи учёта времени.',
    input: { key, worklog_id: worklogId, duration: z.string().optional(), comment: z.string().optional() },
  }, async ({ key: k, worklog_id, duration, comment }) => {
    if (duration === undefined && comment === undefined) throw new Error('нечего менять: нужен duration или comment');
    const body = { ...(duration ? { duration: parseDuration(duration) } : {}), ...(comment !== undefined ? { comment } : {}) };
    return entry(await api('PATCH', `/issues/${enc(k)}/worklog/${enc(worklog_id)}`, body));
  });

  defineTool(server, 'tracker_delete_worklog', {
    title: 'Трекер: удалить списание',
    kind: 'delete',
    description: 'Удалить запись учёта времени. Перед вызовом назови пользователю запись (дата, длительность) и получи согласие.',
    input: { key, worklog_id: worklogId },
  }, async ({ key: k, worklog_id }) => {
    const target = (await api('GET', `/issues/${enc(k)}/worklog`)).find((w) => String(w.id) === String(worklog_id));
    if (!target) throw new Error(`у ${k} нет записи учёта времени ${worklog_id}`);
    await api('DELETE', `/issues/${enc(k)}/worklog/${enc(worklog_id)}`);
    return { deleted: true, ...entry(target) };
  });
}
