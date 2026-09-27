/** Трекер: связи между задачами. */

import { z } from 'zod';
import { defineTool } from './util.mjs';

/** Типы связи API — со стороны задачи, у которой связь создаётся. */
const RELATIONS = {
  relates: 'связана',
  'depends on': 'эта задача зависит от указанной (указанная её блокирует)',
  'is dependent by': 'указанная задача зависит от этой (эта её блокирует)',
  'is subtask for': 'эта задача — подзадача указанной',
  'is parent task for': 'эта задача — родительская для указанной',
  duplicates: 'эта задача дублирует указанную',
  'is duplicated by': 'указанная задача дублирует эту',
  'is epic of': 'эта задача — эпик для указанной',
  'has epic': 'эпик этой задачи — указанная',
};

export function registerTrackerLinks({ server, config, api, enc, link, key }) {
  const linksOf = async (k) => (await api('GET', `/issues/${enc(k)}/links`)).map(link);

  defineTool(server, 'tracker_get_links', {
    title: 'Трекер: связи задачи',
    description: 'Связи задачи: relation — кем связанная задача приходится этой («Родительская задача», «Подзадача», «Связана»…), её ключ, статус, исполнитель.',
    input: { key },
  }, ({ key: k }) => linksOf(k));

  if (config.readonly) return;

  defineTool(server, 'tracker_link_issues', {
    title: 'Трекер: связать задачи',
    kind: 'write',
    description:
      'Связать задачу key с задачей issue. relationship — со стороны key: ' +
      Object.entries(RELATIONS).map(([k, v]) => `"${k}" — ${v}`).join('; ') + '.',
    input: {
      key,
      relationship: z.enum(Object.keys(RELATIONS)),
      issue: z.string().describe('Ключ второй задачи'),
    },
  }, async ({ key: k, relationship, issue }) => {
    const created = await api('POST', `/issues/${enc(k)}/links`, { relationship, issue });
    return link(created);
  });

  defineTool(server, 'tracker_delete_link', {
    title: 'Трекер: убрать связь',
    kind: 'delete',
    description: 'Удалить связь по id из tracker_get_links. Сами задачи не меняются; связь можно создать заново.',
    input: { key, link_id: z.union([z.string(), z.number()]).describe('id связи') },
  }, async ({ key: k, link_id }) => {
    const target = (await linksOf(k)).find((l) => String(l.id) === String(link_id));
    if (!target) throw new Error(`у ${k} нет связи ${link_id}`);
    await api('DELETE', `/issues/${enc(k)}/links/${enc(link_id)}`);
    return { deleted: true, ...target };
  });
}
