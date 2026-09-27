/** Проверки без сети: время, текст писем, разбор iCalendar. Запуск: node --test test/unit.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import MailComposer from 'nodemailer/lib/mail-composer';
import { parseUserTime, formatInTz, htmlToText, startOfDay } from '../src/util.mjs';
import { icalHelpers } from '../src/calendar.mjs';
import { parseDuration, durationHours } from '../src/tracker-worklog.mjs';
import { parsePermissions, GROUPS, TOOL_GROUPS, PRESETS } from '../src/permissions.mjs';

test('права: заготовки, группы, маски и исключения', () => {
  assert.deepEqual([...parsePermissions('read')], ['tracker.read', 'mail.read', 'calendar.read']);
  const assist = parsePermissions('assist');
  assert.ok(assist.has('mail.draft') && assist.has('tracker.comment'));
  assert.ok(!assist.has('mail.send') && !assist.has('calendar.write'));
  const custom = parsePermissions('full,-mail.send');
  assert.equal(custom.size, Object.keys(GROUPS).length - 1);
  assert.ok(!custom.has('mail.send'));
  assert.deepEqual([...parsePermissions(['read', 'tracker.*'])].filter((g) => g.startsWith('tracker')).length, 5);
  assert.throws(() => parsePermissions('mail.everything'), /неизвестное право/);
  // каждая группа из списка инструментов существует, а заготовки ссылаются только на существующие группы
  for (const g of Object.values(TOOL_GROUPS)) assert.ok(g === null || GROUPS[g], `нет группы ${g}`);
  for (const p of Object.values(PRESETS)) for (const g of p.groups) assert.ok(GROUPS[g]);
});

const TZ = 'Europe/Moscow';
const { occurrences, icalTime, buildEvent, applyUpdate } = icalHelpers(TZ);

test('время без смещения читается в заданном поясе', () => {
  assert.equal(parseUserTime('2026-09-28T10:00', TZ).date.toISOString(), '2026-09-28T07:00:00.000Z');
  assert.equal(parseUserTime('2026-09-28 10:00', TZ).date.toISOString(), '2026-09-28T07:00:00.000Z');
  assert.equal(parseUserTime('2026-09-28T10:00:00Z', TZ).date.toISOString(), '2026-09-28T10:00:00.000Z');
  const d = parseUserTime('2026-09-28', TZ);
  assert.equal(d.dateOnly, true);
  assert.equal(d.date.toISOString(), '2026-09-27T21:00:00.000Z');
  // пояс с переходом на летнее время
  assert.equal(parseUserTime('2026-07-01T12:00', 'Europe/Berlin').date.toISOString(), '2026-07-01T10:00:00.000Z');
  assert.equal(parseUserTime('2026-01-01T12:00', 'Europe/Berlin').date.toISOString(), '2026-01-01T11:00:00.000Z');
  assert.throws(() => parseUserTime('завтра', TZ), /не понимаю дату/);
});

test('формат и начало суток в поясе', () => {
  const d = new Date('2026-09-27T22:30:00Z'); // в Москве уже 28-е, 01:30
  assert.equal(formatInTz(d, TZ), '2026-09-28 01:30');
  assert.equal(formatInTz(d, TZ, { dateOnly: true }), '2026-09-28');
  assert.equal(startOfDay(d, TZ).toISOString(), '2026-09-27T21:00:00.000Z');
});

test('HTML письма превращается в читаемый текст', () => {
  const html = '<html><head><style>p{}</style></head><body><p>Привет,&nbsp;коллеги!</p><ul><li>раз</li><li>два</li></ul>' +
    '<a href="https://tracker.yandex.ru/PROJ-1">задача</a><br>&laquo;ок&raquo; &#8212; &#x41;</body></html>';
  assert.equal(htmlToText(html), 'Привет, коллеги!\n• раз\n• два\nзадача (https://tracker.yandex.ru/PROJ-1)\n«ок» — A');
});

const VTZ_MSK = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Moscow',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0300', 'TZNAME:MSK', 'DTSTART:19700101T000000', 'END:STANDARD',
  'END:VTIMEZONE',
];
const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//RU', ...lines, 'END:VCALENDAR'].join('\r\n');
const range = (a, b) => [parseUserTime(a, TZ).date, parseUserTime(b, TZ).date];

test('повторяющаяся встреча: серия, перенос одного вхождения и отмена другого', () => {
  const data = cal(
    ...VTZ_MSK,
    'BEGIN:VEVENT', 'UID:weekly-1', 'DTSTAMP:20260901T000000Z',
    'DTSTART;TZID=Europe/Moscow:20260907T100000', 'DTEND;TZID=Europe/Moscow:20260907T103000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Europe/Moscow:20260921T100000',
    'SUMMARY:Планёрка', 'ATTENDEE;CN=Андрей;PARTSTAT=ACCEPTED:mailto:andrey@example.ru', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:weekly-1', 'DTSTAMP:20260901T000000Z',
    'RECURRENCE-ID;TZID=Europe/Moscow:20260928T100000',
    'DTSTART;TZID=Europe/Moscow:20260928T120000', 'DTEND;TZID=Europe/Moscow:20260928T123000',
    'SUMMARY:Планёрка (перенос)', 'END:VEVENT',
  );
  const [from, to] = range('2026-09-14', '2026-10-06');
  const list = occurrences('Мои события', 'https://caldav/1.ics', data, from, to);
  assert.deepEqual(list.map((e) => [e.start, e.end, e.summary]), [
    ['2026-09-14 10:00', '2026-09-14 10:30', 'Планёрка'],
    // 21.09 отменено через EXDATE
    ['2026-09-28 12:00', '2026-09-28 12:30', 'Планёрка (перенос)'],
    ['2026-10-05 10:00', '2026-10-05 10:30', 'Планёрка'],
  ]);
  assert.equal(list[0].recurring, true);
  assert.deepEqual(list[0].attendees, [{ email: 'andrey@example.ru', name: 'Андрей', status: 'ACCEPTED' }]);
  assert.equal(list[0].href, 'https://caldav/1.ics');
});

test('событие на весь день, событие в UTC и TZID без VTIMEZONE', () => {
  const [from, to] = range('2026-09-28', '2026-09-30');
  const allDay = occurrences('К', 'h', cal('BEGIN:VEVENT', 'UID:a', 'DTSTAMP:20260901T000000Z',
    'DTSTART;VALUE=DATE:20260929', 'DTEND;VALUE=DATE:20260930', 'SUMMARY:Выпуск', 'END:VEVENT'), from, to);
  assert.deepEqual(allDay.map((e) => [e.start, e.end, e.allDay]), [['2026-09-29', '2026-09-29', true]]);

  const utc = occurrences('К', 'h', cal('BEGIN:VEVENT', 'UID:b', 'DTSTAMP:20260901T000000Z',
    'DTSTART:20260928T070000Z', 'DTEND:20260928T080000Z', 'SUMMARY:UTC', 'END:VEVENT'), from, to);
  assert.equal(utc[0].start, '2026-09-28 10:00');

  const bare = occurrences('К', 'h', cal('BEGIN:VEVENT', 'UID:c', 'DTSTAMP:20260901T000000Z',
    'DTSTART;TZID=Asia/Yekaterinburg:20260928T120000', 'DTEND;TZID=Asia/Yekaterinburg:20260928T130000',
    'SUMMARY:Екатеринбург', 'END:VEVENT'), from, to);
  assert.equal(bare[0].start, '2026-09-28 10:00'); // 12:00 +05 = 10:00 МСК
});

test('события вне окна не попадают в выдачу', () => {
  const [from, to] = range('2026-09-28', '2026-09-29');
  const data = cal('BEGIN:VEVENT', 'UID:d', 'DTSTAMP:20260901T000000Z',
    'DTSTART:20260927T200000Z', 'DTEND:20260927T210000Z', 'SUMMARY:вчера', 'END:VEVENT'); // 23:00–00:00 МСК 27-го
  assert.deepEqual(occurrences('К', 'h', data, from, to), []);
});

test('ввод времени для нового события', () => {
  const t = icalTime('2026-09-28T10:00');
  assert.equal(t.dateOnly, false);
  assert.equal(t.time.toString(), '2026-09-28T07:00:00Z');
  const d = icalTime('2026-09-28');
  assert.equal(d.dateOnly, true);
  assert.equal(d.time.toString(), '2026-09-28');
});

test('новое событие: время в UTC, участники, напоминание; читается обратно', () => {
  const ev = buildEvent({
    summary: 'Разбор выпуска, длинное название с запятой и точкой; чтобы проверить экранирование и перенос строк',
    start: '2026-09-28T10:00',
    attendees: ['andrey@example.ru'],
    reminder_minutes: 15,
    organizer: 'ivan@example.ru',
    uid: 'fixed-uid',
  });
  assert.equal(ev.start, '2026-09-28 10:00');
  assert.equal(ev.end, '2026-09-28 11:00');
  assert.match(ev.ics, /^DTSTART:20260928T070000Z$/m);
  assert.match(ev.ics, /^DTEND:20260928T080000Z$/m);
  assert.match(ev.ics, /^ORGANIZER;CN=ivan@example\.ru:mailto:ivan@example\.ru$/m);
  // длинные строки iCalendar переносятся (RFC 5545 §3.1) — сравниваем развёрнутый текст
  assert.match(ev.ics.replace(/\r\n /g, ''), /^ATTENDEE;.*RSVP=TRUE.*:mailto:andrey@example\.ru\r?$/m);
  assert.match(ev.ics, /^TRIGGER:-PT15M$/m);
  const [from, to] = range('2026-09-28', '2026-09-29');
  const [back] = occurrences('К', 'h', ev.ics, from, to);
  assert.equal(back.summary, 'Разбор выпуска, длинное название с запятой и точкой; чтобы проверить экранирование и перенос строк');
  assert.equal(back.start, '2026-09-28 10:00');
});

test('новое событие на несколько дней и ошибки ввода', () => {
  const ev = buildEvent({ summary: 'Командировка', start: '2026-09-29', end: '2026-09-30' });
  assert.match(ev.ics, /^DTSTART;VALUE=DATE:20260929$/m);
  assert.match(ev.ics, /^DTEND;VALUE=DATE:20261001$/m);
  assert.deepEqual([ev.start, ev.end], ['2026-09-29', '2026-09-30']);
  const [from, to] = range('2026-09-28', '2026-10-05');
  const [back] = occurrences('К', 'h', ev.ics, from, to);
  assert.deepEqual([back.start, back.end, back.allDay], ['2026-09-29', '2026-09-30', true]);

  assert.throws(() => buildEvent({ summary: 'x', start: '2026-09-28T10:00', end: '2026-09-28T09:00' }), /позже начала/);
  assert.throws(() => buildEvent({ summary: 'x', start: '2026-09-28', end: '2026-09-28T09:00' }), /оба датами/);
});

test('правка события: сдвиг начала сохраняет длительность, пустое место убирается', () => {
  const data = cal(
    ...VTZ_MSK,
    'BEGIN:VEVENT', 'UID:e1', 'DTSTAMP:20260901T000000Z', 'SEQUENCE:2',
    'DTSTART;TZID=Europe/Moscow:20260928T100000', 'DTEND;TZID=Europe/Moscow:20260928T103000',
    'SUMMARY:Созвон', 'LOCATION:Переговорная 3', 'END:VEVENT',
  );
  const { ics, event } = applyUpdate(data, { start: '2026-09-29T15:00', summary: 'Созвон (перенос)', location: '' }, { calendar: 'К', href: 'h' });
  assert.deepEqual([event.start, event.end, event.summary, event.location], ['2026-09-29 15:00', '2026-09-29 15:30', 'Созвон (перенос)', undefined]);
  assert.match(ics, /^SEQUENCE:3$/m);
  assert.doesNotMatch(ics, /^LOCATION/m);
  assert.match(ics, /^DTSTART:20260929T120000Z$/m);

  const onlyEnd = applyUpdate(data, { end: '2026-09-28T11:00' }, { calendar: 'К', href: 'h' });
  assert.deepEqual([onlyEnd.event.start, onlyEnd.event.end], ['2026-09-28 10:00', '2026-09-28 11:00']);
  assert.throws(() => applyUpdate(data, { end: '2026-09-28T09:00' }), /позже начала/);
});

test('длительность списания: по-человечески и в ISO', () => {
  assert.equal(parseDuration('1ч 30м'), 'PT1H30M');
  assert.equal(parseDuration('2h'), 'PT2H');
  assert.equal(parseDuration('1.5ч'), 'PT1H30M');
  assert.equal(parseDuration('1,25 часа'), 'PT1H15M');
  assert.equal(parseDuration('90 мин'), 'PT1H30M');
  assert.equal(parseDuration('1д 4ч'), 'P1DT4H');
  assert.equal(parseDuration('2 дней'), 'P2D');
  assert.equal(parseDuration('1н'), 'P1W');
  assert.equal(parseDuration('pt45m'), 'PT45M');
  assert.equal(parseDuration('P1W2DT3H'), 'P1W2DT3H');
  assert.throws(() => parseDuration('PT'), /не понимаю/);
  assert.throws(() => parseDuration('полдня'), /не понимаю/);
  assert.throws(() => parseDuration('2 попугая'), /единицу/);
  assert.throws(() => parseDuration('1.5д'), /только целые/);
  assert.throws(() => parseDuration('0ч'), /больше нуля/);
});

test('длительность в часах по правилам Трекера', () => {
  assert.equal(durationHours('PT15M'), 0.25);
  assert.equal(durationHours('PT1H30M'), 1.5);
  assert.equal(durationHours('P1D'), 8);
  assert.equal(durationHours('P1W2DT3H'), 59);
  assert.equal(durationHours('ерунда'), undefined);
});

test('ответ на письмо собирается с правильными заголовками', async () => {
  const raw = (await new MailComposer({
    from: { name: 'Иван Иванов', address: 'ivan@example.ru' },
    to: 'andrey@example.ru',
    subject: 'Re: Выпуск 1.3.0',
    text: 'Принято.',
    inReplyTo: '<abc@example.ru>',
    references: ['<abc@example.ru>'],
  }).compile().build()).toString();
  assert.match(raw, /^In-Reply-To: <abc@example\.ru>/m);
  assert.match(raw, /^Subject: =\?UTF-8\?/m);
  assert.match(raw, /^From: =\?UTF-8\?.+<ivan@example\.ru>/m);
});
