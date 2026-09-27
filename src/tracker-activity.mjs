/**
 * Трекер: что человек сделал за период — по истории изменений задач и комментариям.
 * В языке запросов Трекера нет «Updated By» и «Status Changed», поэтому кандидатов ищем по ролям и обновлению,
 * а действия берём из /changelog и оставляем только сделанные этим человеком в пределах периода.
 */

import { z } from 'zod';
import { defineTool, parseUserTime, formatInTz, truncate } from './util.mjs';

/** Поля, изменения которых — мелочь для отчёта (не показываются как отдельное действие). */
const MINOR = new Set(['checklistItems', 'followers', 'boards', 'tags', 'statusStartTime', 'statusType', 'lastCommentUpdatedAt', 'previousStatus', 'previousStatusLastAssignee', 'pendingReplyFrom', 'access', 'votedBy', 'favorite', 'updatedBy', 'commentWithoutExternalMessageCount', 'commentWithExternalMessageCount']);
const FIELD = {
  summary: 'название', description: 'описание', assignee: 'исполнитель', deadline: 'срок', storyPoints: 'оценка',
  sprint: 'спринт', priority: 'приоритет', components: 'компоненты', parent: 'родитель', type: 'тип', fixVersions: 'версия',
  resolution: 'резолюция', start: 'начало', end: 'конец', estimation: 'оценка времени', spent: 'затрачено',
};

const show = (v) => (v == null ? '—' : v.display ?? v.key ?? v.id ?? String(v));
const pool = async (items, n, fn) => {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
};

export function registerTrackerActivity({ server, config, api, enc, ref, url }) {
  const tz = config.tz;

  /** Кто: текущий пользователь или сотрудник по логину/почте. Все его идентификаторы — для сверки автора изменений. */
  async function who(user) {
    if (!user) {
      const me = await api('GET', '/myself');
      return { login: me.login, name: me.display, expr: 'me()', ids: [me.uid, me.trackerUid, me.passportUid, me.cloudUid] };
    }
    const u = await api('GET', `/users/${enc(user)}`).catch(() => null);
    if (!u) throw new Error(`нет пользователя «${user}» — найдите логин через tracker_find_user`);
    return { login: u.login, name: u.display, expr: u.login, ids: [u.uid, u.trackerUid, u.passportUid, u.cloudUid] };
  }

  /** История изменений задачи целиком (постранично, до 5 страниц). */
  async function changelog(key) {
    const all = [];
    let after = '';
    for (let page = 0; page < 5; page++) {
      const batch = await api('GET', `/issues/${enc(key)}/changelog?perPage=100${after ? `&id=${enc(after)}` : ''}`);
      all.push(...batch);
      if (batch.length < 100) break;
      after = batch.at(-1).id;
    }
    return all;
  }

  defineTool(server, 'tracker_my_activity', {
    title: 'Трекер: активность за период',
    description:
      'Что человек (по умолчанию — вы) сделал в Трекере за период: создал, сменил статус, закрыл, прокомментировал, ' +
      'изменил поля — по задачам, самое важное сверху. Для стендапа и отчётов. Период — в поясе пользователя; ' +
      'может занять до полуминуты на неделю активной работы.',
    input: {
      from: z.string().describe('Начало: 2026-09-26 или 2026-09-26T09:00'),
      to: z.string().optional().describe('Конец (не включая); по умолчанию — сейчас'),
      user: z.string().optional().describe('Логин или почта сотрудника; по умолчанию — вы'),
      limit: z.number().int().min(1).max(100).default(100).describe('Сколько задач разбирать не больше'),
    },
  }, async ({ from, to, user, limit }) => {
    const start = parseUserTime(from, tz).date;
    const end = to ? parseUserTime(to, tz).date : new Date();
    if (end <= start) throw new Error('конец периода должен быть позже начала');
    const person = await who(user);
    const ids = new Set(person.ids.filter(Boolean).map(String));
    const mine = (x) => ids.has(String(x?.id));
    const inPeriod = (at) => {
      const t = new Date(at).getTime();
      return t >= start.getTime() && t < end.getTime();
    };

    const day = formatInTz(start, tz, { dateOnly: true });
    const r = person.expr;
    const query = `Updated: >= "${day}" (Assignee: ${r} OR Author: ${r} OR "Comment Author": ${r} OR Followers: ${r}) "Sort by": Updated DESC`;
    const candidates = await api('POST', `/issues/_search?perPage=${Math.min(100, limit)}`, { query });

    const results = await pool(candidates, 6, async (issue) => {
      const log = (await changelog(issue.key)).filter((e) => mine(e.updatedBy) && inPeriod(e.updatedAt));
      if (!log.length) return null;
      const actions = [];
      const changed = new Set();
      const path = []; // статусы по порядку: Открыт → В работе → … → Закрыт
      let resolution;
      let minor = 0;
      let comments = 0;
      let links = 0;
      let weight = 0;
      for (const e of log) {
        if (e.type === 'IssueCreated') {
          actions.push('создал');
          weight = Math.max(weight, 3);
        } else if (e.type === 'IssueWorkflow') {
          const st = e.fields?.find((f) => f.field?.id === 'status');
          const res = e.fields?.find((f) => f.field?.id === 'resolution');
          if (st) {
            if (!path.length || path.at(-1) !== show(st.from)) path.push(show(st.from));
            path.push(show(st.to));
          }
          if (res?.to) resolution = show(res.to);
          weight = Math.max(weight, res?.to ? 5 : 4);
        } else if (e.type === 'IssueCommentAdded') {
          comments++;
          weight = Math.max(weight, 2);
        } else if (e.type === 'IssueLinked') {
          links++;
        } else if (/Worklog/i.test(e.type)) {
          actions.push('списал время');
          weight = Math.max(weight, 2);
        } else {
          for (const f of e.fields ?? []) {
            if (MINOR.has(f.field?.id)) minor++;
            else changed.add(FIELD[f.field?.id] ?? f.field?.display ?? f.field?.id);
          }
          if (changed.size) weight = Math.max(weight, 1);
        }
      }
      if (path.length) actions.push(`статус: ${path.join(' → ')}${resolution ? ` (${resolution})` : ''}`);
      if (changed.size) actions.push(`изменил: ${[...changed].join(', ')}`);
      if (links) actions.push(`связи: ${links}`);
      let commentTexts;
      if (comments) {
        const list = await api('GET', `/issues/${enc(issue.key)}/comments?perPage=100`).catch(() => []);
        commentTexts = list.filter((c) => mine(c.createdBy) && inPeriod(c.createdAt)).map((c) => truncate(String(c.text ?? ''), 200).text);
        actions.push(`комментарии: ${comments}`);
      }
      if (!actions.length && minor) actions.push('мелкие правки (чеклист, наблюдатели, метки)');
      return {
        key: issue.key,
        summary: issue.summary,
        statusNow: ref(issue.status),
        url: url(issue.key),
        actions,
        ...(commentTexts?.length ? { comments: commentTexts } : {}),
        last: formatInTz(new Date(log.at(-1).updatedAt), tz),
        weight,
      };
    });

    const issues = results.filter(Boolean).sort((a, b) => b.weight - a.weight || b.last.localeCompare(a.last));
    const count = (w) => issues.filter((i) => i.weight === w).length;
    return {
      who: person.name,
      from: formatInTz(start, tz),
      to: formatInTz(end, tz),
      totals: { issues: issues.length, closed: count(5), statusChanged: count(4), created: count(3) },
      ...(candidates.length >= Math.min(100, limit) ? { note: `разобраны первые ${candidates.length} задач — сузьте период, если нужно больше` } : {}),
      // важность: 5 — закрыл, 4 — сменил статус, 3 — создал, 2 — комментарий или время, 1 — правка полей, 0 — мелочи
      issues: issues.map(({ weight, ...i }) => ({ ...i, importance: weight })),
    };
  });
}
