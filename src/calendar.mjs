/** Яндекс Календарь по CalDAV (https://caldav.yandex.ru). */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDAVClient } from 'tsdav';
import ICAL from 'ical.js';
import { defineTool, parseUserTime, formatInTz, startOfDay, truncate } from './util.mjs';

const DAY = 24 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');
const isObjectUrl = (u) => !!u && !u.endsWith('/');

function isIanaZone(name) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Разбор и сборка iCalendar без сети — отдельно, чтобы проверять тестами. */
export function icalHelpers(tz) {
  function parse(data) {
    const comp = new ICAL.Component(ICAL.parse(data));
    for (const vtz of comp.getAllSubcomponents('vtimezone')) {
      try {
        ICAL.TimezoneService.register(vtz);
      } catch {
        // битый VTIMEZONE — время будет разобрано по TZID или поясу по умолчанию
      }
    }
    return comp;
  }

  /** ICAL.Time → Date. fallbackZone — TZID из DTSTART, если VTIMEZONE не пришёл. */
  function toDate(t, fallbackZone) {
    if (t.isDate) return parseUserTime(`${t.year}-${pad(t.month)}-${pad(t.day)}`, tz).date;
    const zone = t.zone;
    if (zone && zone !== ICAL.Timezone.localTimezone && zone.tzid !== 'floating') return t.toJSDate();
    const wall = `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
    return parseUserTime(wall, fallbackZone && isIanaZone(fallbackZone) ? fallbackZone : tz).date;
  }

  function describe(calendar, href, vevent, start, end, allDay, recurring) {
    const val = (n) => vevent.getFirstPropertyValue(n);
    const email = (p) => String(p.getFirstValue() ?? '').replace(/^mailto:/i, '');
    const organizer = vevent.getFirstProperty('organizer');
    const attendees = vevent.getAllProperties('attendee').map((p) => ({
      email: email(p),
      name: p.getParameter('cn') || undefined,
      status: p.getParameter('partstat') || undefined,
    }));
    const description = val('description');
    return {
      calendar,
      summary: val('summary') || '(без названия)',
      start: formatInTz(start, tz, { dateOnly: allDay }),
      end: formatInTz(allDay ? new Date(end.getTime() - 1) : end, tz, { dateOnly: allDay }),
      allDay,
      recurring,
      location: val('location') || undefined,
      link: val('url') || undefined,
      description: description ? truncate(String(description), 1000).text : undefined,
      organizer: organizer ? { email: email(organizer), name: organizer.getParameter('cn') || undefined } : undefined,
      attendees: attendees.length ? attendees : undefined,
      status: val('status') || undefined,
      uid: val('uid'),
      href,
    };
  }

  /** Все вхождения событий объекта в окне [from, to), с раскрытием повторений и исключений. */
  function occurrences(calendar, href, data, from, to) {
    const comp = parse(data);
    const vevents = comp.getAllSubcomponents('vevent');
    const masters = vevents.filter((v) => !v.hasProperty('recurrence-id'));
    const overrides = vevents.filter((v) => v.hasProperty('recurrence-id'));
    const out = [];
    const push = (vevent, startT, endT, tzid, recurring) => {
      const start = toDate(startT, tzid);
      const end = endT ? toDate(endT, tzid) : new Date(start.getTime() + (startT.isDate ? DAY : 0));
      if (start < to && (end > from || (end.getTime() === start.getTime() && start >= from))) {
        out.push(describe(calendar, href, vevent, start, end, startT.isDate, recurring));
      }
    };

    for (const master of masters) {
      const event = new ICAL.Event(master);
      const tzid = master.getFirstProperty('dtstart')?.getParameter('tzid');
      for (const o of overrides) {
        if (o.getFirstPropertyValue('uid') === event.uid) event.relateException(o);
      }
      if (!event.isRecurring()) {
        push(master, event.startDate, event.endDate, tzid, false);
        continue;
      }
      const it = event.iterator();
      for (let next, n = 0; (next = it.next()) && n < 20000; n++) {
        const d = event.getOccurrenceDetails(next);
        if (toDate(d.startDate, tzid) >= to) break;
        push(d.item.component, d.startDate, d.endDate, tzid, true);
      }
    }
    // Исключения без основного события в том же объекте (приглашение на одно вхождение)
    const masterUids = new Set(masters.map((m) => m.getFirstPropertyValue('uid')));
    for (const o of overrides) {
      if (masterUids.has(o.getFirstPropertyValue('uid'))) continue;
      const e = new ICAL.Event(o);
      push(o, e.startDate, e.endDate, o.getFirstProperty('dtstart')?.getParameter('tzid'), true);
    }
    return out;
  }

  /** Время из ввода пользователя → ICAL.Time: дата без времени — событие на весь день. */
  function icalTime(value) {
    const { date, dateOnly } = parseUserTime(value, tz);
    if (dateOnly) return { time: ICAL.Time.fromDateString(String(value).trim().slice(0, 10)), date, dateOnly };
    return { time: ICAL.Time.fromJSDate(date, true), date, dateOnly };
  }

  const setProp = (vevent, name, value) => {
    vevent.removeAllProperties(name);
    if (value !== undefined && value !== null && value !== '') vevent.addPropertyWithValue(name, value);
  };

  /** Новое событие → текст iCalendar. Время — в UTC, событие на день — датами. */
  function buildEvent({ summary, start, end, description, location, attendees, reminder_minutes, organizer, uid = randomUUID(), now = new Date() }) {
    const s = icalTime(start);
    let e;
    if (end) {
      e = icalTime(end);
      if (e.dateOnly !== s.dateOnly) throw new Error('начало и конец должны быть оба датами (весь день) или оба с временем');
      if (s.dateOnly) {
        // для события на день конец в iCalendar — следующий день после последнего
        const t = e.time.clone();
        t.adjust(1, 0, 0, 0);
        e = { ...e, time: t, date: new Date(e.date.getTime() + DAY) };
      }
    } else {
      const t = s.time.clone();
      if (s.dateOnly) t.adjust(1, 0, 0, 0);
      else t.adjust(0, 1, 0, 0);
      e = { time: t, date: new Date(s.date.getTime() + (s.dateOnly ? DAY : 3600 * 1000)) };
    }
    if (e.date <= s.date) throw new Error('конец события должен быть позже начала');

    const vcal = new ICAL.Component('vcalendar');
    vcal.addPropertyWithValue('prodid', '-//ya360-mcp//RU');
    vcal.addPropertyWithValue('version', '2.0');
    const vevent = new ICAL.Component('vevent');
    vevent.addPropertyWithValue('uid', uid);
    vevent.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(now, true));
    vevent.addPropertyWithValue('dtstart', s.time);
    vevent.addPropertyWithValue('dtend', e.time);
    vevent.addPropertyWithValue('summary', summary);
    if (description) vevent.addPropertyWithValue('description', description);
    if (location) vevent.addPropertyWithValue('location', location);
    if (attendees?.length) {
      const org = vevent.addPropertyWithValue('organizer', `mailto:${organizer}`);
      org.setParameter('cn', organizer);
      for (const a of attendees) {
        const p = vevent.addPropertyWithValue('attendee', `mailto:${a}`);
        p.setParameter('partstat', 'NEEDS-ACTION');
        p.setParameter('rsvp', 'TRUE');
        p.setParameter('role', 'REQ-PARTICIPANT');
      }
    }
    if (reminder_minutes !== undefined) {
      const alarm = new ICAL.Component('valarm');
      alarm.addPropertyWithValue('action', 'DISPLAY');
      alarm.addPropertyWithValue('description', summary);
      alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-reminder_minutes * 60));
      vevent.addSubcomponent(alarm);
    }
    vcal.addSubcomponent(vevent);
    return {
      ics: `${vcal.toString()}\r\n`,
      uid,
      start: formatInTz(s.date, tz, { dateOnly: s.dateOnly }),
      end: formatInTz(s.dateOnly ? new Date(e.date.getTime() - DAY) : e.date, tz, { dateOnly: s.dateOnly }),
    };
  }

  /**
   * Правка основного VEVENT объекта. Меняется только переданное; при сдвиге начала без конца
   * длительность сохраняется. Возвращает новый текст и описание события.
   */
  function applyUpdate(data, { summary, start, end, description, location }, { calendar, href, now = new Date() } = {}) {
    const comp = parse(data);
    const vevent = comp.getAllSubcomponents('vevent').find((v) => !v.hasProperty('recurrence-id')) ?? comp.getFirstSubcomponent('vevent');
    if (!vevent) throw new Error('в объекте нет VEVENT');
    const event = new ICAL.Event(vevent);
    const tzid = vevent.getFirstProperty('dtstart')?.getParameter('tzid');
    const oldStart = toDate(event.startDate, tzid);
    const oldEnd = event.endDate ? toDate(event.endDate, tzid) : oldStart;

    if (summary !== undefined) setProp(vevent, 'summary', summary);
    if (description !== undefined) setProp(vevent, 'description', description);
    if (location !== undefined) setProp(vevent, 'location', location);

    if (start !== undefined || end !== undefined) {
      const s = start !== undefined ? icalTime(start) : null;
      const allDay = s ? s.dateOnly : event.startDate.isDate;
      if (s) setProp(vevent, 'dtstart', s.time);
      const hasDuration = vevent.hasProperty('duration');
      if (end !== undefined) {
        const e = icalTime(end);
        if (e.dateOnly !== allDay) throw new Error('начало и конец должны быть оба датами (весь день) или оба с временем');
        if (e.dateOnly) e.time.adjust(1, 0, 0, 0);
        vevent.removeAllProperties('duration');
        setProp(vevent, 'dtend', e.time);
      } else if (s && !hasDuration) {
        let t;
        if (s.dateOnly) {
          t = s.time.clone();
          t.adjust(Math.max(1, Math.round((oldEnd - oldStart) / DAY)), 0, 0, 0);
        } else {
          t = ICAL.Time.fromJSDate(new Date(s.date.getTime() + (oldEnd - oldStart)), true);
        }
        setProp(vevent, 'dtend', t);
      }
      const check = new ICAL.Event(vevent);
      if (check.endDate && toDate(check.endDate, tzid) <= toDate(check.startDate, tzid)) {
        throw new Error('конец события должен быть позже начала');
      }
    }
    const seq = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
    setProp(vevent, 'sequence', seq + 1);
    setProp(vevent, 'dtstamp', ICAL.Time.fromJSDate(now, true));
    setProp(vevent, 'last-modified', ICAL.Time.fromJSDate(now, true));

    const updated = new ICAL.Event(vevent);
    const ns = toDate(updated.startDate, tzid);
    const ne = updated.endDate ? toDate(updated.endDate, tzid) : ns;
    return {
      ics: `${comp.toString()}\r\n`,
      event: describe(calendar, href, vevent, ns, ne, updated.startDate.isDate, updated.isRecurring()),
    };
  }

  return { parse, toDate, describe, occurrences, icalTime, buildEvent, applyUpdate };
}

export function registerCalendar(server, config) {
  const c = config.calendar;
  const tz = config.tz;

  // клиент CalDAV запоминает заголовок входа при создании — после продления токена создаём заново
  let clientPromise;
  let clientKey;
  const dav = async () => {
    const cr = await c.credentials();
    const key = cr.type === 'oauth' ? cr.token : 'password';
    if (clientPromise && clientKey === key) return clientPromise;
    clientKey = key;
    const auth =
      cr.type === 'oauth'
        ? { credentials: {}, authMethod: 'Custom', authFunction: async () => ({ Authorization: `OAuth ${cr.token}` }) }
        : { credentials: { username: cr.username, password: cr.password }, authMethod: 'Basic' };
    clientPromise = createDAVClient({ serverUrl: c.url, defaultAccountType: 'caldav', ...auth }).catch((err) => {
      clientPromise = undefined;
      const hint = cr.type === 'oauth' ? 'Проверь, что у OAuth-приложения есть право calendar:all.' : 'Проверь логин и пароль приложения типа «Календарь».';
      throw new Error(`не удалось войти в CalDAV (${c.url}): ${err.message}. ${hint}`);
    });
    return clientPromise;
  };

  const nameOf = (cal) => (typeof cal.displayName === 'string' && cal.displayName) || cal.url;
  const { parse, occurrences, buildEvent, applyUpdate } = icalHelpers(tz);

  async function eventCalendars() {
    const client = await dav();
    const list = await client.fetchCalendars();
    return list.filter((cal) => !cal.components?.length || cal.components.includes('VEVENT'));
  }

  async function pickCalendar(name) {
    const list = await eventCalendars();
    if (!list.length) throw new Error('в аккаунте нет календарей событий');
    const want = name || c.defaultCalendar;
    if (!want) return list[0];
    const hit = list.find((cal) => nameOf(cal).toLowerCase() === want.toLowerCase() || cal.url === want);
    if (!hit) throw new Error(`нет календаря «${want}». Есть: ${list.map(nameOf).join(', ')}`);
    return hit;
  }

  // сравниваем декодированные пути: сервер может отдать @ как %40 в одном месте и как есть в другом
  const pathOf = (u) => decodeURIComponent(new URL(u, c.url).pathname);

  async function objectByHref(href) {
    const cal = (await eventCalendars()).find((x) => pathOf(href).startsWith(pathOf(x.url)));
    if (!cal) throw new Error('событие не принадлежит ни одному календарю аккаунта (href из calendar_list_events?)');
    const client = await dav();
    const [obj] = await client.fetchCalendarObjects({ calendar: cal, objectUrls: [href], urlFilter: isObjectUrl });
    if (!obj?.data) throw new Error('событие не найдено — возможно, уже удалено');
    return { cal, obj, client };
  }

  const checkResponse = async (res, what) => {
    if (!res.ok) throw new Error(`CalDAV: ${what} — ${res.status} ${res.statusText} ${(await res.text().catch(() => '')).slice(0, 300)}`);
  };

  // ───────────────────────────────────────────── чтение

  defineTool(server, 'calendar_list_calendars', {
    title: 'Календарь: календари',
    description: 'Календари событий аккаунта (первый — календарь по умолчанию, если не задан YANDEX_CALENDAR_DEFAULT).',
  }, async () => {
    const list = await eventCalendars();
    return list.map((cal) => ({ name: nameOf(cal), href: cal.url, timezone: cal.timezone || undefined, color: cal.calendarColor || undefined }));
  });

  defineTool(server, 'calendar_list_events', {
    title: 'Календарь: события',
    description:
      `События за период с раскрытием повторяющихся. Даты без смещения — в поясе ${tz}. ` +
      'По умолчанию — с сегодняшнего дня на 7 дней вперёд, по всем календарям. href события нужен для изменения и удаления.',
    input: {
      from: z.string().optional().describe('Начало периода: 2026-09-28 или 2026-09-28T09:00'),
      to: z.string().optional().describe('Конец периода (не включая); по умолчанию from + 7 дней'),
      calendar: z.string().optional().describe('Название календаря; по умолчанию все'),
      query: z.string().optional().describe('Подстрока в названии, описании, месте'),
      limit: z.number().int().min(1).max(500).default(200),
    },
  }, async ({ from, to, calendar, query, limit }) => {
    const start = from ? parseUserTime(from, tz).date : startOfDay(new Date(), tz);
    const end = to ? parseUserTime(to, tz).date : new Date(start.getTime() + 7 * DAY);
    if (end <= start) throw new Error('конец периода должен быть позже начала');
    const client = await dav();
    const cals = calendar ? [await pickCalendar(calendar)] : await eventCalendars();
    const events = [];
    const errors = [];
    for (const cal of cals) {
      try {
        const objects = await client.fetchCalendarObjects({
          calendar: cal,
          timeRange: { start: start.toISOString(), end: end.toISOString() },
          urlFilter: isObjectUrl,
        });
        for (const obj of objects) {
          if (!obj.data) continue;
          try {
            events.push(...occurrences(nameOf(cal), obj.url, obj.data, start, end));
          } catch (err) {
            errors.push(`${obj.url}: ${err.message}`);
          }
        }
      } catch (err) {
        errors.push(`${nameOf(cal)}: ${err.message}`);
      }
    }
    const q = query?.toLowerCase();
    const list = events
      .filter((e) => !q || [e.summary, e.description, e.location].some((s) => s?.toLowerCase().includes(q)))
      .sort((a, b) => a.start.localeCompare(b.start));
    return {
      from: formatInTz(start, tz),
      to: formatInTz(end, tz),
      timezone: tz,
      count: list.length,
      events: list.slice(0, limit),
      ...(errors.length ? { errors } : {}),
    };
  });

  // ───────────────────────────────────────────── запись

  const eventFields = {
    summary: z.string().describe('Название'),
    start: z.string().describe(`Начало: 2026-09-28T10:00 (пояс ${tz}) или 2026-09-28 для события на весь день`),
    end: z.string().optional().describe('Конец; по умолчанию +1 час (для дня — тот же день)'),
    description: z.string().optional(),
    location: z.string().optional(),
  };

  defineTool(server, 'calendar_create_event', {
    title: 'Календарь: новое событие',
    kind: 'write',
    description:
      'Создать событие. Если указаны attendees, Яндекс разошлёт им приглашения — перед этим покажи пользователю ' +
      'время и список участников и получи согласие.',
    input: {
      ...eventFields,
      calendar: z.string().optional().describe('Название календаря; по умолчанию основной'),
      attendees: z.array(z.string()).optional().describe('Адреса участников'),
      reminder_minutes: z.number().int().min(0).optional().describe('Напоминание за N минут'),
    },
  }, async ({ calendar, ...fields }) => {
    const cal = await pickCalendar(calendar);
    const ev = buildEvent({ ...fields, organizer: c.user });
    const client = await dav();
    const filename = `${ev.uid}.ics`;
    const res = await client.createCalendarObject({ calendar: cal, filename, iCalString: ev.ics });
    await checkResponse(res, 'создание события');
    return {
      created: true,
      calendar: nameOf(cal),
      summary: fields.summary,
      start: ev.start,
      end: ev.end,
      attendees: fields.attendees,
      uid: ev.uid,
      href: new URL(filename, cal.url.endsWith('/') ? cal.url : `${cal.url}/`).href,
    };
  });

  defineTool(server, 'calendar_update_event', {
    title: 'Календарь: изменить событие',
    kind: 'write',
    description:
      'Изменить событие по href из calendar_list_events: название, время, место, описание. ' +
      'Если меняется только начало, длительность сохраняется. У повторяющегося события меняется вся серия. ' +
      'Участники получат уведомление об изменении.',
    input: {
      href: z.string(),
      summary: z.string().optional(),
      start: eventFields.start.optional(),
      end: eventFields.end,
      description: z.string().optional().describe('Новое описание; пустая строка — убрать'),
      location: z.string().optional().describe('Новое место; пустая строка — убрать'),
    },
  }, async ({ href, ...fields }) => {
    const { cal, obj, client } = await objectByHref(href);
    const { ics, event } = applyUpdate(obj.data, fields, { calendar: nameOf(cal), href: obj.url });
    const res = await client.updateCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag, data: ics } });
    await checkResponse(res, 'изменение события');
    return { updated: true, ...event };
  });

  defineTool(server, 'calendar_delete_event', {
    title: 'Календарь: удалить событие',
    kind: 'delete',
    description:
      'Удалить событие по href (у повторяющегося — всю серию). Необратимо: перед вызовом назови пользователю событие и получи согласие.',
    input: { href: z.string() },
  }, async ({ href }) => {
    const { cal, obj, client } = await objectByHref(href);
    const summary = parse(obj.data).getFirstSubcomponent('vevent')?.getFirstPropertyValue('summary');
    const res = await client.deleteCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag } });
    await checkResponse(res, 'удаление события');
    return { deleted: true, calendar: nameOf(cal), summary, href: obj.url };
  });
}
