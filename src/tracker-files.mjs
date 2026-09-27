/** Трекер: вложения задач. */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import { defineTool, saveDownload, localFile } from './util.mjs';

const MAX_UPLOAD = 100 * 1024 * 1024;

export function registerTrackerFiles({ server, config, request, api, enc, attachmentOut, key }) {
  const list = (k) => api('GET', `/issues/${enc(k)}/attachments`);
  const find = async (k, id) => {
    const a = (await list(k)).find((x) => String(x.id) === String(id));
    if (!a) throw new Error(`у ${k} нет вложения ${id}`);
    return a;
  };
  const attachmentId = z.union([z.string(), z.number()]).describe('id вложения из tracker_list_attachments');

  defineTool(server, 'tracker_list_attachments', {
    title: 'Трекер: вложения',
    description: 'Файлы, приложенные к задаче: id, имя, размер, кто и когда приложил.',
    input: { key },
  }, async ({ key: k }) => (await list(k)).map(attachmentOut));

  defineTool(server, 'tracker_download_attachment', {
    title: 'Трекер: скачать вложение',
    description:
      `Скачать вложение задачи в папку загрузок сервера (${config.downloadDir}) и вернуть путь — ` +
      'дальше файл можно открыть обычными средствами. Не запускай скачанное.',
    input: { key, attachment_id: attachmentId },
  }, async ({ key: k, attachment_id }) => {
    const a = await find(k, attachment_id);
    const res = await request('GET', a.content, undefined, { raw: true });
    const data = Buffer.from(await res.arrayBuffer());
    const path = saveDownload(config.downloadDir, a.name, data);
    return { path, name: a.name, size: data.length, mimetype: a.mimetype };
  });

  if (config.readonly) return;

  defineTool(server, 'tracker_upload_attachment', {
    title: 'Трекер: приложить файл',
    kind: 'write',
    description: 'Приложить локальный файл к задаче (до 100 МБ). Файл увидят все, у кого есть доступ к задаче. Скрытые файлы (.env и т. п.) не отправляются.',
    input: {
      key,
      path: z.string().describe('Путь к локальному файлу'),
      filename: z.string().optional().describe('Имя в Трекере; по умолчанию имя файла'),
    },
  }, async ({ key: k, path, filename }) => {
    const full = localFile(path);
    const size = statSync(full).size;
    if (size > MAX_UPLOAD) throw new Error(`файл ${Math.round(size / 1048576)} МБ — больше 100 МБ`);
    const name = filename || basename(full);
    const form = new FormData();
    form.append('file', new Blob([readFileSync(full)]), name);
    // имя дублируем параметром: так кириллица в имени доходит без искажений
    const created = await api('POST', `/issues/${enc(k)}/attachments?filename=${enc(name)}`, form);
    return attachmentOut(created);
  });

  defineTool(server, 'tracker_delete_attachment', {
    title: 'Трекер: удалить вложение',
    kind: 'delete',
    description: 'Удалить вложение задачи. Необратимо: перед вызовом назови пользователю файл и получи согласие.',
    input: { key, attachment_id: attachmentId },
  }, async ({ key: k, attachment_id }) => {
    const a = await find(k, attachment_id);
    await api('DELETE', `/issues/${enc(k)}/attachments/${enc(a.id)}/`);
    return { deleted: true, ...attachmentOut(a) };
  });
}
