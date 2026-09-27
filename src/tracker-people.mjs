/** Трекер: люди организации — сопоставить имя или адрес с логином (исполнители, призывы, участники встреч). */

import { z } from 'zod';
import { defineTool } from './util.mjs';

const TTL = 10 * 60 * 1000;
const words = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[.,()]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Насколько пользователь подходит к запросу: 100 — логин или адрес точно; 70 — то же имя ящика на другом домене;
 * 50–60 — каждое слово запроса начинает какое-то слово имени («Иван С» → «Иван Петрович Сидоров»).
 */
export function matchUser(user, query) {
  const q = String(query).trim().toLowerCase();
  if (!q) return 0;
  if (user.login?.toLowerCase() === q || user.email?.toLowerCase() === q) return 100;
  if (q.includes('@') && user.email && user.email.toLowerCase().split('@')[0] === q.split('@')[0]) return 70;
  const qw = words(q.replace(/@.*/, ''));
  const uw = words(user.display);
  if (!qw.length || !qw.every((w) => uw.some((x) => x.startsWith(w)))) return 0;
  return qw.length >= 2 ? 60 : 50;
}

export function registerTrackerPeople({ server, api }) {
  let cache;
  async function users() {
    if (cache && Date.now() - cache.at < TTL) return cache.list;
    const list = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await api('GET', `/users?perPage=100&page=${page}`);
      list.push(...batch);
      if (batch.length < 100) break;
    }
    cache = { at: Date.now(), list };
    return list;
  }

  defineTool(server, 'tracker_find_user', {
    title: 'Трекер: найти человека',
    description:
      'Найти сотрудника в Трекере по логину, адресу почты или имени (можно неполному: «Андрей Б», «Мария Смирнова»). ' +
      'Возвращает логин (для исполнителя и призыва), имя, почту. exact: true — совпадение однозначное; ' +
      'если кандидатов несколько — спроси пользователя, не выбирай наугад.',
    input: {
      query: z.string().min(1),
      include_dismissed: z.boolean().default(false).describe('Показывать уволенных'),
    },
  }, async ({ query, include_dismissed }) => {
    const scored = (await users())
      .filter((u) => include_dismissed || !u.dismissed)
      .map((u) => ({ u, score: matchUser(u, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const top = scored[0]?.score ?? 0;
    const best = scored.filter((x) => x.score === top);
    // однозначно: точный логин или адрес; либо единственный кандидат по имени.
    // Совпадение только имени ящика на другом домене (ivan@gmail ↔ ivan@company) однозначным не считаем — это могут быть разные люди.
    return {
      exact: best.length === 1 && (top === 100 || (top < 70 && scored.length === 1)),
      matches: scored.slice(0, 10).map(({ u, score }) => ({
        login: u.login,
        name: u.display,
        email: u.email,
        ...(u.dismissed ? { dismissed: true } : {}),
        match: score === 100 ? 'точно' : score >= 60 ? 'похоже' : 'частично',
      })),
    };
  });

  return { users };
}
