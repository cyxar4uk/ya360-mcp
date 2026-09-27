/** Трекер: доски и спринты. */

import { z } from 'zod';
import { defineTool } from './util.mjs';

const TTL = 10 * 60 * 1000; // доски и спринты меняются редко — не спрашиваем сервер на каждый вызов
const STATUS = { draft: 'запланирован', in_progress: 'идёт', released: 'завершён', archived: 'в архиве' };
const MAX_ISSUES = 1000;

export function registerTrackerAgile({ server, config, api, enc, ref, url, key }) {
  const cache = new Map();
  const cached = async (name, load) => {
    const hit = cache.get(name);
    if (hit && Date.now() - hit.at < TTL) return hit.value;
    const value = await load();
    cache.set(name, { at: Date.now(), value });
    return value;
  };
  const boards = () => cached('boards', () => api('GET', '/boards'));
  // у досок без спринтов (канбан, простые) Трекер отвечает 400 — такие доски считаем пустыми
  const sprintsOf = (boardId) =>
    cached(`sprints:${boardId}`, () =>
      api('GET', `/boards/${enc(boardId)}/sprints`).catch((err) => {
        if (/ответил 400/.test(err.message)) return null;
        throw err;
      }));

  const sprintOut = (s) => ({
    id: s.id,
    name: s.name,
    board: s.board?.display,
    boardId: s.board?.id,
    status: STATUS[s.status] ?? s.status,
    start: s.startDate,
    end: s.endDate,
  });

  /** Выбор по имени: точное совпадение → начало имени → подстрока. */
  function pick(list, want, nameOf, what) {
    const w = want.toLowerCase();
    for (const test of [(n) => n === w, (n) => n.startsWith(w), (n) => n.includes(w)]) {
      const hits = list.filter((x) => test(nameOf(x).toLowerCase()));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new Error(`«${want}» подходит к нескольким (${what}): ${hits.map(nameOf).join('; ')} — уточни`);
    }
    return null;
  }

  async function resolveBoard(board) {
    const list = await boards();
    const hit = list.find((b) => String(b.id) === String(board)) ?? pick(list, String(board), (b) => b.name, 'доски');
    if (!hit) throw new Error(`нет доски «${board}». Есть: ${list.map((b) => `${b.id} ${b.name}`).join('; ')}`);
    return hit;
  }

  /** sprint — id, имя или его начало («S1»); без sprint — идущий спринт. board сужает поиск. */
  async function resolveSprint(sprint, board) {
    if (sprint !== undefined && /^\d+$/.test(String(sprint))) return api('GET', `/sprints/${enc(sprint)}`);
    const where = board ? [await resolveBoard(board)] : await boards();
    const all = (await Promise.all(where.map((b) => sprintsOf(b.id)))).flatMap((list) => list ?? []);
    if (board && !all.length) throw new Error(`у доски «${where[0].name}» нет спринтов`);
    if (sprint === undefined) {
      const active = all.filter((s) => s.status === 'in_progress');
      if (active.length === 1) return active[0];
      if (!active.length) throw new Error('идущего спринта нет — укажи sprint');
      throw new Error(`идут несколько спринтов: ${active.map((s) => `${s.name} (${s.board?.display})`).join('; ')} — укажи sprint или board`);
    }
    const hit = pick(all, String(sprint), (s) => s.name, 'спринты');
    if (!hit) throw new Error(`нет спринта «${sprint}»${board ? ` на доске «${board}»` : ''}`);
    return hit;
  }

  const sprintArg = z.union([z.string(), z.number()]).optional().describe('id, имя или начало имени («S1»); без него — идущий спринт');
  const boardArg = z.union([z.string(), z.number()]).optional().describe('id или название доски — сужает поиск спринта');

  defineTool(server, 'tracker_list_boards', {
    title: 'Трекер: доски',
    description: 'Доски организации: id, название, колонки.',
    input: { query: z.string().optional().describe('Подстрока в названии') },
  }, async ({ query }) => {
    const q = query?.toLowerCase();
    return (await boards())
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .map((b) => ({ id: b.id, name: b.name, columns: b.columns?.map(ref) }));
  });

  defineTool(server, 'tracker_list_sprints', {
    title: 'Трекер: спринты доски',
    description: 'Спринты доски по порядку: id, имя, статус (запланирован / идёт / завершён), даты.',
    input: {
      board: z.union([z.string(), z.number()]).describe('id или название доски'),
      include_archived: z.boolean().default(false),
    },
  }, async ({ board, include_archived }) => {
    const b = await resolveBoard(board);
    const list = await sprintsOf(b.id);
    if (!list) throw new Error(`доска «${b.name}» без спринтов (канбан или простая доска)`);
    return list
      .filter((s) => include_archived || !s.archived)
      .sort((a, c) => String(a.startDate).localeCompare(String(c.startDate)))
      .map(sprintOut);
  });

  defineTool(server, 'tracker_sprint_issues', {
    title: 'Трекер: задачи спринта',
    description:
      'Задачи спринта и сводка: сколько задач и очков в каждом статусе и у каждого исполнителя, сколько не закрыто. ' +
      'include_issues=false — только сводка.',
    input: { sprint: sprintArg, board: boardArg, include_issues: z.boolean().default(true) },
  }, async ({ sprint, board, include_issues }) => {
    const s = await resolveSprint(sprint, board);
    const issues = [];
    for (let page = 1; issues.length < MAX_ISSUES; page++) {
      const batch = await api('POST', `/issues/_search?perPage=100&page=${page}`, { filter: { sprint: String(s.id) } });
      issues.push(...batch);
      if (batch.length < 100) break;
    }
    const rows = issues.map((i) => ({
      key: i.key,
      summary: i.summary,
      status: ref(i.status),
      assignee: ref(i.assignee) ?? 'без исполнителя',
      points: i.storyPoints ?? 0,
      components: i.components?.map(ref),
      done: !!i.resolution,
      url: url(i.key),
    }));
    const group = (field) => {
      const m = new Map();
      for (const r of rows) {
        const g = m.get(r[field]) ?? { [field]: r[field], count: 0, points: 0, open: 0, openPoints: 0 };
        g.count++;
        g.points += r.points;
        if (!r.done) {
          g.open++;
          g.openPoints += r.points;
        }
        m.set(r[field], g);
      }
      return [...m.values()].sort((a, b) => b.points - a.points);
    };
    const points = rows.reduce((a, r) => a + r.points, 0);
    const openRows = rows.filter((r) => !r.done);
    return {
      sprint: sprintOut(s),
      total: {
        issues: rows.length,
        points,
        open: openRows.length,
        openPoints: openRows.reduce((a, r) => a + r.points, 0),
        ...(issues.length >= MAX_ISSUES ? { note: `показаны первые ${MAX_ISSUES}` } : {}),
      },
      byStatus: group('status').map(({ open, openPoints, ...g }) => g),
      byAssignee: group('assignee'),
      ...(include_issues ? { issues: rows.sort((a, b) => a.assignee.localeCompare(b.assignee) || a.status.localeCompare(b.status)) } : {}),
    };
  });

  defineTool(server, 'tracker_set_sprint', {
    title: 'Трекер: задача в спринт',
    kind: 'write',
    description:
      'Поставить задачу в спринт (заменяет прежний спринт задачи). Состав спринта — решение планирования: ' +
      'меняй только по прямой просьбе пользователя.',
    input: { key, sprint: z.union([z.string(), z.number()]).describe('id, имя или начало имени («S2»)'), board: boardArg },
  }, async ({ key: k, sprint, board }) => {
    const s = await resolveSprint(sprint, board);
    const issue = await api('PATCH', `/issues/${enc(k)}`, { sprint: [{ id: String(s.id) }] });
    return { key: issue.key, sprint: issue.sprint?.map(ref), url: url(issue.key) };
  });
}
