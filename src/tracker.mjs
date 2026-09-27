/** Яндекс Трекер: API v3 (https://yandex.ru/support/tracker/ru/about-api). */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool, truncate } from './util.mjs';
import { registerTrackerLinks } from './tracker-links.mjs';
import { registerTrackerFiles } from './tracker-files.mjs';
import { registerTrackerWorklog } from './tracker-worklog.mjs';
import { registerTrackerAgile } from './tracker-agile.mjs';
import { registerTrackerPeople } from './tracker-people.mjs';
import { registerTrackerActivity } from './tracker-activity.mjs';

/**
 * Числовая метка источника задачи: поиск Трекера по тексту находит числа, а не произвольные строки
 * (`Description: ~"…"` не фильтрует вовсе). Встреча — её номер и номер пункта; остальное — число из хеша.
 */
export function sourceMarker({ kind, id, item }) {
  if (kind === 'meeting' && /^\d{4,}$/.test(id)) return `${id}${String(item ?? 0).padStart(3, '0')}`;
  const hex = createHash('sha256').update(`${kind}:${String(id).trim()}:${item ?? ''}`).digest('hex').slice(0, 13);
  return BigInt(`0x${hex}`).toString().padStart(16, '0');
}

export function registerTracker(server, config) {
  const t = config.tracker;

  const apiHost = new URL(t.api).host;

  /**
   * path — путь от корня API или полный адрес (ссылки на вложения приходят полными).
   * body — объект (уйдёт JSON) или FormData. raw — вернуть Response как есть (скачивание файлов).
   */
  async function request(method, path, body, { raw = false } = {}) {
    const target = path.startsWith('http') ? new URL(path) : new URL(`${t.api}${path}`);
    // токен уходит только в API Трекера, даже если адрес пришёл из ответа сервера
    if (target.host !== apiHost) throw new Error(`отказ: адрес ${target.host} не относится к API Трекера`);
    const headers = { Authorization: await t.authorization() };
    if (t.orgId) headers['X-Org-Id'] = t.orgId;
    else headers['X-Cloud-Org-Id'] = t.cloudOrgId;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(target, { method, headers, body: payload });
    if (raw && res.ok) return res;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const detail =
        data?.errorMessages?.join('; ') ||
        (data?.errors && Object.keys(data.errors).length ? JSON.stringify(data.errors) : '') ||
        String(text).slice(0, 500);
      throw new Error(`Трекер ответил ${res.status} на ${method} ${path}: ${detail}`);
    }
    return { data, total: res.headers.get('X-Total-Count') };
  }
  const api = async (...args) => (await request(...args)).data;
  const enc = encodeURIComponent;

  const ref = (x) => (x == null ? undefined : x.display ?? x.key ?? x.id);
  const url = (key) => `${t.ui}/${key}`;

  const brief = (i) => ({
    key: i.key,
    summary: i.summary,
    status: ref(i.status),
    type: ref(i.type),
    priority: ref(i.priority),
    assignee: ref(i.assignee),
    updatedAt: i.updatedAt,
    // срок, оценка и спринт нужны для просрочек и загрузки — показываем, только если заданы
    ...(i.deadline ? { deadline: i.deadline } : {}),
    ...(i.storyPoints != null ? { storyPoints: i.storyPoints } : {}),
    ...(i.sprint?.length ? { sprint: i.sprint.map(ref) } : {}),
    url: url(i.key),
  });

  const full = (i) => ({
    ...brief(i),
    queue: i.queue?.key,
    parent: i.parent?.key,
    author: ref(i.createdBy),
    followers: i.followers?.map(ref),
    sprint: i.sprint?.map(ref),
    storyPoints: i.storyPoints,
    components: i.components?.map(ref),
    fixVersions: i.fixVersions?.map(ref),
    tags: i.tags,
    deadline: i.deadline,
    resolution: ref(i.resolution),
    createdAt: i.createdAt,
    description: i.description,
    checklist: i.checklistItems?.map((c) => ({ id: c.id, text: c.text, checked: c.checked })),
  });

  const comment = (c) => ({
    id: c.id,
    author: ref(c.createdBy),
    createdAt: c.createdAt,
    text: truncate(c.text, 4000).text,
  });

  /**
   * Связь глазами текущей задачи: relation — кем связанная задача приходится этой.
   * В API подписи типа даны с обеих сторон; direction говорит, с какой стороны стоит текущая задача.
   */
  const link = (l) => ({
    id: l.id,
    relation: l.direction === 'outward' ? l.type?.inward : l.type?.outward,
    type: l.type?.id,
    key: l.object?.key,
    summary: l.object?.display,
    status: ref(l.status),
    assignee: ref(l.assignee),
  });

  const attachmentOut = (a) => ({
    id: a.id,
    name: a.name,
    size: a.size,
    mimetype: a.mimetype,
    author: ref(a.createdBy),
    createdAt: a.createdAt,
  });

  /** Задача с меткой источника: поиск по тексту находит число, точность проверяем по описанию. */
  async function findByMarker(marker) {
    const found = await api('POST', '/issues/_search?perPage=10', { query: `"${marker}"` });
    return found.find((i) => String(i.description ?? '').includes(`Метка ya360: ${marker}`)) ?? null;
  }

  const key = z.string().describe('Ключ задачи, например PROJ-123');
  const ctx = { server, config, request, api, enc, ref, url, brief, full, link, attachmentOut, key };

  defineTool(server, 'tracker_whoami', {
    title: 'Трекер: кто я',
    description: 'Текущий пользователь Трекера (логин, имя). Удобно для проверки подключения.',
  }, async () => {
    const me = await api('GET', '/myself');
    return { login: me.login, display: me.display, email: me.email, uid: me.uid };
  });

  defineTool(server, 'tracker_list_queues', {
    title: 'Трекер: очереди',
    description: 'Список очередей организации: ключ, название, руководитель.',
  }, async () => {
    const queues = await api('GET', '/queues?perPage=200');
    return queues.map((q) => ({ key: q.key, name: q.name, lead: ref(q.lead) }));
  });

  defineTool(server, 'tracker_search_issues', {
    title: 'Трекер: поиск задач',
    description:
      'Поиск задач. Либо query на языке запросов Трекера, например ' +
      '`Assignee: me() Resolution: empty() "Sort by": Updated DESC` или `Queue: PROJ Status: "В работе"`, ' +
      'либо filter — объект полей, например {"assignee": "ivanov", "status": "inProgress"}. ' +
      'queue добавляется к любому из вариантов; без условий — очередь по умолчанию из настроек. ' +
      'Возвращает краткие карточки; подробности — tracker_get_issue.',
    input: {
      query: z.string().optional().describe('Запрос на языке запросов Трекера'),
      queue: z.string().optional().describe('Ключ очереди, например PROJ'),
      filter: z.record(z.string(), z.any()).optional().describe('Фильтр по полям (если нет query)'),
      order: z.string().optional().describe('Сортировка для filter, например "-updated" или "+created"'),
      limit: z.number().int().min(1).max(100).default(20),
      page: z.number().int().min(1).default(1),
    },
  }, async ({ query, queue, filter, order, limit, page }) => {
    let body;
    if (query) {
      body = { query: queue ? `Queue: ${queue} ${query}` : query };
    } else {
      const f = { ...(filter ?? {}) };
      const q = queue || (!Object.keys(f).length ? t.defaultQueue : '');
      if (q) f.queue = q;
      if (!Object.keys(f).length) throw new Error('нужен query, queue или filter (очередь по умолчанию не задана)');
      body = { filter: f, ...(order ? { order } : {}) };
    }
    const { data, total } = await request('POST', `/issues/_search?perPage=${limit}&page=${page}`, body);
    return { total: total ? Number(total) : data.length, page, issues: data.map(brief) };
  });

  defineTool(server, 'tracker_get_issue', {
    title: 'Трекер: задача',
    description:
      'Карточка задачи: поля, описание, чеклист; по желанию — комментарии, связи, вложения. ' +
      'raw=true — весь JSON задачи, включая поля очереди.',
    input: {
      key,
      include_comments: z.boolean().default(false),
      include_links: z.boolean().default(false),
      include_attachments: z.boolean().default(false),
      raw: z.boolean().default(false),
    },
  }, async ({ key: k, include_comments, include_links, include_attachments, raw }) => {
    const issue = await api('GET', `/issues/${enc(k)}`);
    const out = raw ? issue : full(issue);
    if (include_comments) {
      const comments = await api('GET', `/issues/${enc(k)}/comments?perPage=100`);
      out.comments = comments.map(comment);
    }
    if (include_links) out.links = (await api('GET', `/issues/${enc(k)}/links`)).map(link);
    if (include_attachments) out.attachments = (await api('GET', `/issues/${enc(k)}/attachments`)).map(attachmentOut);
    return out;
  });

  defineTool(server, 'tracker_get_comments', {
    title: 'Трекер: комментарии',
    description: 'Комментарии задачи, от старых к новым.',
    input: { key, limit: z.number().int().min(1).max(100).default(50) },
  }, async ({ key: k, limit }) => {
    const comments = await api('GET', `/issues/${enc(k)}/comments?perPage=${limit}`);
    return comments.map(comment);
  });

  defineTool(server, 'tracker_get_transitions', {
    title: 'Трекер: доступные переходы',
    description: 'Переходы статуса, доступные для задачи сейчас (id нужен для tracker_transition_issue).',
    input: { key },
  }, async ({ key: k }) => {
    const list = await api('GET', `/issues/${enc(k)}/transitions`);
    return list.map((x) => ({ id: x.id, name: x.display, to: ref(x.to) }));
  });

  registerTrackerLinks(ctx);
  registerTrackerFiles(ctx);
  registerTrackerWorklog(ctx);
  registerTrackerAgile(ctx);
  registerTrackerPeople(ctx);
  registerTrackerActivity(ctx);

  defineTool(server, 'tracker_add_comment', {
    title: 'Трекер: комментарий',
    kind: 'write',
    description: 'Добавить комментарий к задаче. summon — логины, кого призвать. Текст видят все участники задачи — показывай его пользователю до отправки.',
    input: {
      key,
      text: z.string().min(1),
      summon: z.array(z.string()).optional().describe('Логины для призыва'),
    },
  }, async ({ key: k, text, summon }) => {
    const c = await api('POST', `/issues/${enc(k)}/comments`, { text, ...(summon?.length ? { summonees: summon } : {}) });
    return { id: c.id, url: `${url(k)}#${c.longId ?? c.id}` };
  });

  defineTool(server, 'tracker_create_issue', {
    title: 'Трекер: новая задача',
    kind: 'write',
    description:
      'Создать задачу. fields — любые дополнительные поля API (sprint, storyPoints, components, tags, followers, deadline, поля очереди). ' +
      'source — откуда задача (встреча, письмо): в описание добавится строка «Источник: …» с меткой, и если задача с такой меткой ' +
      'уже есть, новая не создаётся — вернётся существующая (duplicate: true). ' +
      'Если в проекте есть свой регламент заведения задач (скрипт, обязательные поля) — следуй ему.',
    input: {
      queue: z.string().optional().describe('Ключ очереди; по умолчанию — из настроек'),
      summary: z.string().min(1),
      description: z.string().optional(),
      type: z.string().optional().describe('Тип: task, bug, epic… (ключ типа)'),
      parent: z.string().optional().describe('Ключ родительской задачи'),
      assignee: z.string().optional().describe('Логин исполнителя'),
      priority: z.string().optional().describe('Ключ приоритета: minor, normal, critical…'),
      fields: z.record(z.string(), z.any()).optional(),
      source: z.object({
        kind: z.enum(['meeting', 'mail', 'other']),
        id: z.string().min(1).describe('№ встречи Телемоста, Message-ID письма или другой устойчивый идентификатор'),
        item: z.number().int().min(0).optional().describe('Номер пункта (для встречи)'),
        label: z.string().optional().describe('Как назвать источник: «встреча „Планирование", 26.09.2026, пункт 3»'),
      }).optional(),
    },
  }, async ({ queue, summary, description, type, parent, assignee, priority, fields, source }) => {
    const q = queue || t.defaultQueue;
    if (!q) throw new Error('нужна очередь (queue): очередь по умолчанию не задана');
    let marker;
    if (source) {
      marker = sourceMarker(source);
      const existing = await findByMarker(marker);
      if (existing) return { duplicate: true, note: 'задача из этого источника уже есть — новая не создана', ...brief(existing) };
      const label = source.label || { meeting: `встреча №${source.id}`, mail: 'письмо', other: source.id }[source.kind];
      description = `${description ? `${description}\n\n` : ''}---\nИсточник: ${label}. Метка ya360: ${marker}`;
    }
    const body = { queue: q, summary, ...fields };
    if (description) body.description = description;
    if (type) body.type = type;
    if (parent) body.parent = parent;
    if (assignee) body.assignee = assignee;
    if (priority) body.priority = priority;
    const issue = await api('POST', '/issues/', body);
    return brief(issue);
  });

  defineTool(server, 'tracker_update_issue', {
    title: 'Трекер: изменить задачу',
    kind: 'write',
    description:
      'Изменить поля задачи. fields — как в API: {"summary": "…"}, {"assignee": "login"}, ' +
      '{"tags": {"add": ["x"]}}, {"sprint": [{"id": 12}]}. Статус так не меняется — для него tracker_transition_issue.',
    input: { key, fields: z.record(z.string(), z.any()) },
  }, async ({ key: k, fields }) => {
    const issue = await api('PATCH', `/issues/${enc(k)}`, fields);
    return full(issue);
  });

  defineTool(server, 'tracker_transition_issue', {
    title: 'Трекер: сменить статус',
    kind: 'write',
    description: 'Выполнить переход статуса (id из tracker_get_transitions). fields — поля экрана перехода, например {"resolution": "fixed"}.',
    input: {
      key,
      transition: z.string().describe('id перехода'),
      comment: z.string().optional(),
      fields: z.record(z.string(), z.any()).optional(),
    },
  }, async ({ key: k, transition, comment: text, fields }) => {
    const body = { ...fields, ...(text ? { comment: text } : {}) };
    await api('POST', `/issues/${enc(k)}/transitions/${enc(transition)}/_execute`, body);
    const issue = await api('GET', `/issues/${enc(k)}`);
    return brief(issue);
  });

  defineTool(server, 'tracker_set_checklist_item', {
    title: 'Трекер: пункт чеклиста',
    kind: 'write',
    description: 'Отметить или снять отметку с пункта чеклиста (id пункта — из tracker_get_issue).',
    input: { key, item_id: z.string(), checked: z.boolean().default(true) },
  }, async ({ key: k, item_id, checked }) => {
    await api('PATCH', `/issues/${enc(k)}/checklistItems/${enc(item_id)}`, { checked });
    const issue = await api('GET', `/issues/${enc(k)}`);
    return full(issue).checklist ?? [];
  });
}
