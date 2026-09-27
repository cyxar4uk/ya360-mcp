/**
 * Права доступа: каждый инструмент принадлежит одной группе, включённые группы задаются настройкой.
 * Инструмент без группы — ошибка при запуске: новое нельзя добавить, не решив, кому оно доступно.
 */

export const GROUPS = {
  'tracker.read': 'Трекер: чтение задач, комментариев, связей, вложений, списаний, досок и спринтов',
  'tracker.comment': 'Трекер: комментарии',
  'tracker.edit': 'Трекер: создание и правка задач, статусы, чеклисты, связи, спринт',
  'tracker.files': 'Трекер: загрузка и удаление вложений',
  'tracker.worklog': 'Трекер: учёт времени',
  'mail.read': 'Почта: папки, поиск, чтение, сохранение вложений',
  'mail.draft': 'Почта: черновики',
  'mail.organize': 'Почта: отметки и перенос по папкам',
  'mail.send': 'Почта: отправка писем',
  'calendar.read': 'Календарь: календари и события',
  'calendar.write': 'Календарь: создание, правка и удаление событий',
};

const T = (group, names) => Object.fromEntries(names.map((n) => [n, group]));

export const TOOL_GROUPS = {
  yandex_status: null, // доступен всегда
  ...T('tracker.read', [
    'tracker_whoami', 'tracker_list_queues', 'tracker_search_issues', 'tracker_get_issue', 'tracker_get_comments',
    'tracker_get_transitions', 'tracker_get_links', 'tracker_list_attachments', 'tracker_download_attachment',
    'tracker_get_worklog', 'tracker_search_worklog', 'tracker_list_boards', 'tracker_list_sprints', 'tracker_sprint_issues',
  ]),
  ...T('tracker.comment', ['tracker_add_comment']),
  ...T('tracker.edit', [
    'tracker_create_issue', 'tracker_update_issue', 'tracker_transition_issue', 'tracker_set_checklist_item',
    'tracker_link_issues', 'tracker_delete_link', 'tracker_set_sprint',
  ]),
  ...T('tracker.files', ['tracker_upload_attachment', 'tracker_delete_attachment']),
  ...T('tracker.worklog', ['tracker_add_worklog', 'tracker_update_worklog', 'tracker_delete_worklog']),
  ...T('mail.read', ['mail_list_folders', 'mail_search', 'mail_read', 'mail_save_attachment']),
  ...T('mail.draft', ['mail_create_draft']),
  ...T('mail.organize', ['mail_set_flags', 'mail_move']),
  ...T('mail.send', ['mail_send']),
  ...T('calendar.read', ['calendar_list_calendars', 'calendar_list_events']),
  ...T('calendar.write', ['calendar_create_event', 'calendar_update_event', 'calendar_delete_event']),
};

const READ = ['tracker.read', 'mail.read', 'calendar.read'];
export const PRESETS = {
  read: { title: 'только чтение', groups: READ },
  assist: {
    title: 'помощник: чтение, комментарии, черновики, раскладка почты — ничего не отправляет и не удаляет',
    groups: [...READ, 'tracker.comment', 'mail.draft', 'mail.organize'],
  },
  full: { title: 'всё, включая отправку писем и удаление', groups: Object.keys(GROUPS) },
};

/**
 * Разбирает права: заготовки (read, assist, full), группы (mail.send), маски (tracker.*),
 * исключения с минусом (-mail.send). Строка через запятую или массив.
 */
export function parsePermissions(spec) {
  const items = (Array.isArray(spec) ? spec : String(spec ?? '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
  const out = new Set();
  for (const item of items) {
    const minus = item.startsWith('-');
    const name = minus ? item.slice(1) : item;
    let groups;
    if (PRESETS[name]) groups = PRESETS[name].groups;
    else if (name.endsWith('.*')) groups = Object.keys(GROUPS).filter((g) => g.startsWith(name.slice(0, -1)));
    else if (GROUPS[name]) groups = [name];
    if (!groups?.length) {
      throw new Error(`неизвестное право «${item}». Есть: ${[...Object.keys(PRESETS), ...Object.keys(GROUPS)].join(', ')}`);
    }
    for (const g of groups) minus ? out.delete(g) : out.add(g);
  }
  return out;
}

/**
 * Обёртка над сервером MCP: регистрирует только разрешённые инструменты.
 * Возвращает объект с registerTool и списком пропущенных — для yandex_status.
 */
export function gate(server, allowed) {
  const skipped = [];
  return {
    skipped,
    registerTool(name, config, cb) {
      if (!(name in TOOL_GROUPS)) throw new Error(`инструмент ${name} не отнесён ни к одной группе прав (src/permissions.mjs)`);
      const group = TOOL_GROUPS[name];
      if (group && !allowed.has(group)) {
        skipped.push(name);
        return null;
      }
      return server.registerTool(name, config, cb);
    },
  };
}
