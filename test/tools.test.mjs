/** Доработки инструментов под навыки: метка источника, поиск людей, фрагменты расшифровки, вложения, ссылки на встречи. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceMarker } from '../src/tracker.mjs';
import { matchUser } from '../src/tracker-people.mjs';
import { findFragments, attachmentText } from '../src/mail.mjs';
import { meetingLink } from '../src/calendar.mjs';
import { loadSkills, promptText, unplug, parseSkill } from '../src/scenarios.mjs';
import { runCli } from '../src/cli.mjs';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('сценарии: все навыки разбираются, заголовок — до тире, ссылки на плагин переписываются', () => {
  const skills = loadSkills();
  assert.ok(skills.length >= 11);
  for (const s of skills) {
    assert.match(s.name, /^[a-z0-9-]+$/);
    assert.ok(s.description.length > 20, `${s.name}: нет описания`);
    assert.ok(!s.title.includes('—'), `${s.name}: заголовок «${s.title}»`);
  }
  const s = parseSkill('---\nname: x\ndescription: Стендап — что я сделал\nargument-hint: "[дата]"\n---\nСм. `/ya360:mail-to-task`. Аргументы: $ARGUMENTS', 'x');
  assert.equal(s.title, 'Стендап');
  assert.equal(s.hint, '[дата]');
  assert.equal(promptText(s, 'пятница'), 'См. сценарий «mail-to-task». Аргументы: пятница');
  assert.equal(unplug(s.body, 'command'), 'См. `/mail-to-task`. Аргументы: $ARGUMENTS');
});

test('ya360-mcp skills: ставит без префикса, чужие навыки не трогает, удаляет только свои', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ya360-skills-'));
  const log = console.log;
  try {
    mkdirSync(join(dir, 'standup'));
    writeFileSync(join(dir, 'standup', 'SKILL.md'), 'мой собственный навык');
    assert.equal(await runCli(['skills', 'install', dir]), 0);
    assert.equal(readFileSync(join(dir, 'standup', 'SKILL.md'), 'utf8'), 'мой собственный навык', 'чужой навык не затёрт');
    const followup = readFileSync(join(dir, 'meeting-prep', 'SKILL.md'), 'utf8');
    assert.ok(!followup.includes('/ya360:'), 'ссылки без префикса плагина');
    assert.ok(existsSync(join(dir, 'meeting-prep', '.ya360-mcp')));
    assert.equal(await runCli(['skills', 'remove', dir]), 0);
    assert.ok(!existsSync(join(dir, 'meeting-prep')));
    assert.ok(existsSync(join(dir, 'standup', 'SKILL.md')), 'чужой навык не удалён');
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('метка источника: число, устойчивое, разное для разных пунктов и писем', () => {
  assert.equal(sourceMarker({ kind: 'meeting', id: '5893395265', item: 3 }), '5893395265003');
  assert.notEqual(sourceMarker({ kind: 'meeting', id: '5893395265', item: 3 }), sourceMarker({ kind: 'meeting', id: '5893395265', item: 4 }));
  const m = sourceMarker({ kind: 'mail', id: '<abc@mail.example.ru>' });
  assert.match(m, /^\d{16}$/);
  assert.equal(m, sourceMarker({ kind: 'mail', id: ' <abc@mail.example.ru> ' }), 'пробелы по краям не меняют метку');
  assert.notEqual(m, sourceMarker({ kind: 'mail', id: '<abd@mail.example.ru>' }));
  assert.match(sourceMarker({ kind: 'meeting', id: 'не-число', item: 1 }), /^\d{16}$/, 'нечисловой номер встречи — через хеш');
});

test('поиск людей: логин и почта точно, имя по началам слов, чужой домен — только «похоже»', () => {
  const u = { login: 'a.sidorov', email: 'a.sidorov@company.ru', display: 'Андрей Константинович Сидоров' };
  assert.equal(matchUser(u, 'a.sidorov'), 100);
  assert.equal(matchUser(u, 'A.Sidorov@Company.ru'), 100);
  assert.equal(matchUser(u, 'a.sidorov@gmail.com'), 70);
  assert.equal(matchUser(u, 'Андрей Сидоров'), 60);
  assert.equal(matchUser(u, 'Андрей С.'), 60);
  assert.equal(matchUser(u, 'Сидоров'), 50);
  assert.equal(matchUser(u, 'Андрей Смирнов'), 0);
  assert.equal(matchUser({ ...u, display: 'Пётр Иванов' }, 'петр иванов'), 60, 'ё и е не различаются');
});

const TRANSCRIPT = [
  'Андрей Сидоров:',
  '[00:10:01] Давайте по смете.',
  '[00:10:05] Я возьму смету по серверам, сделаю до пятницы.',
  'Мария С. (2):',
  '[00:11:00] Хорошо. Доступы подрядчику проверю я.',
  '[00:11:30] Ещё вопрос по отчёту.',
].join('\n');

test('фрагменты расшифровки: совпадения со соседними строками и говорящим, соседние склеиваются', () => {
  const r = findFragments(TRANSCRIPT, ['смет'], 0);
  assert.equal(r.matches, 2);
  assert.equal(r.fragments.length, 1, 'соседние строки — один фрагмент');
  assert.equal(r.fragments[0].speaker, 'Андрей Сидоров');
  const d = findFragments(TRANSCRIPT, ['ДОСТУП'], 1);
  assert.equal(d.fragments[0].speaker, 'Мария С. (2)');
  assert.match(d.fragments[0].text, /Доступы подрядчику/);
  assert.equal(findFragments(TRANSCRIPT, ['нет такого'], 2).fragments.length, 0);
});

test('фрагменты расшифровки: говорящий в строке — тот, чья метка стоит перед найденным словом', () => {
  const inline = [
    'Олег Смирнов:',
    '[00:18:40] Хорошо.',
    'Олег Смирнов: [00:19:03] А репозиторий вы мне скидывали? Пётр К. (1): [00:19:11] Нет, репозиторий ещё не скидывали. [00:19:13] Закину сегодня.',
    '[00:19:20] И сервер проверю.',
  ].join('\n');
  const r = findFragments(inline, ['закину'], 0);
  assert.equal(r.fragments[0].speaker, 'Пётр К. (1)');
  const s = findFragments(inline, ['сервер'], 0);
  assert.equal(s.fragments[0].speaker, 'Пётр К. (1)', 'строка без метки — последний говорящий выше, в том числе из середины строки');
  const q = findFragments(inline, ['скидывали?'], 0);
  assert.equal(q.fragments[0].speaker, 'Олег Смирнов');
});

test('текст вложения: кодировка из заголовка, windows-1251 без заголовка, HTML в текст, не текст — понятная ошибка', () => {
  const utf = { filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('Привет') };
  assert.equal(attachmentText(utf), 'Привет');
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет» в windows-1251
  assert.equal(attachmentText({ filename: 'b.txt', contentType: 'text/plain', content: cp1251 }), 'Привет');
  const headers = new Map([['content-type', { value: 'text/plain', params: { charset: 'windows-1251' } }]]);
  assert.equal(attachmentText({ filename: 'c', contentType: 'text/plain', headers, content: cp1251 }), 'Привет');
  assert.equal(attachmentText({ filename: 'd.html', contentType: 'text/html', content: Buffer.from('<p>Раз</p><p>Два</p>') }), 'Раз\nДва');
  assert.throws(() => attachmentText({ filename: 'e.png', contentType: 'image/png', content: Buffer.alloc(3) }), /не текст/);
});

test('ссылка на видеовстречу из описания события', () => {
  assert.equal(meetingLink('Подключайтесь: https://telemost.yandex.ru/j/12345678901234. До встречи'), 'https://telemost.yandex.ru/j/12345678901234');
  assert.equal(meetingLink('Zoom https://us02web.zoom.us/j/999?pwd=x'), 'https://us02web.zoom.us/j/999?pwd=x');
  assert.equal(meetingLink('офис, переговорная 3'), undefined);
});
