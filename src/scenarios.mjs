/**
 * Сценарии (skills/<имя>/SKILL.md) вне плагина Claude Code:
 *   — как MCP-подсказки (prompts): в Claude Desktop их выбирают в меню «+» под обычными названиями — «Стендап», «План дня»;
 *   — как личные навыки Claude Code (~/.claude/skills/<имя>): вызываются без префикса плагина — /standup, /day-plan.
 * В плагине навыки уже есть сами по себе, поэтому там подсказки выключаются (YA360_PROMPTS=off).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ROOT } from './config.mjs';

export const SKILLS_DIR = join(ROOT, 'skills');

/** Короткие названия для меню Claude Desktop; нет в списке — начало описания до тире. */
const TITLES = {
  'day-plan': 'План дня',
  'inbox-digest': 'Разбор почты',
  'mail-to-task': 'Письмо в задачу',
  'meeting-followup': 'Итоги встречи',
  'meeting-prep': 'Подготовка к встрече',
  'setup-help': 'Подключение Яндекса',
  'sprint-planning': 'Планирование спринта',
  'sprint-review': 'Сводка спринта',
  'stale-tasks': 'Кто застрял',
  standup: 'Стендап',
  'weekly-report': 'Недельный отчёт',
};

/** Разбор SKILL.md: простые поля frontmatter (name, description, argument-hint) и текст. */
export function parseSkill(raw, fallbackName) {
  const text = raw.replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const meta = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  const description = meta.description ?? '';
  const name = meta.name || fallbackName;
  return {
    name,
    title: TITLES[name] ?? (description.split(/\s+[—–-]\s+/)[0] || name),
    description,
    hint: meta['argument-hint'] ?? '',
    body: (m ? m[2] : text).trim(),
    raw: text,
  };
}

export function loadSkills(dir = SKILLS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
    .map((d) => parseSkill(readFileSync(join(dir, d.name, 'SKILL.md'), 'utf8'), d.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Ссылки «/ya360:имя» вне плагина: в подсказке — по названию сценария, в личных навыках — /имя. */
export const unplug = (text, style) =>
  text.replace(/`?\/ya360:([a-z0-9-]+)`?/g, (_, name) => (style === 'command' ? `\`/${name}\`` : `сценарий «${name}»`));

/** Текст подсказки: инструкция сценария с подставленными уточнениями пользователя. */
export function promptText(skill, args) {
  return unplug(skill.body, 'prompt').replaceAll('$ARGUMENTS', args?.trim() || '(не заданы)');
}

export function registerPrompts(server, skills = loadSkills()) {
  for (const s of skills) {
    server.registerPrompt(s.name, {
      title: s.title,
      description: s.description,
      argsSchema: { args: z.string().optional().describe(s.hint ? `Уточнения: ${s.hint}` : 'Уточнения (необязательно)') },
    }, ({ args }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: promptText(s, args) } }],
    }));
  }
  return skills.length;
}
