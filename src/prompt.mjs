/** Вопросы в консоли для мастера настройки: обычный ввод, скрытый ввод, выбор, да/нет. */

import { createInterface } from 'node:readline/promises';

const out = process.stdout;
const interactive = () => !!process.stdin.isTTY;

// Ввод не с клавиатуры (ответы переданы потоком — скрипт, тест): одна общая очередь строк,
// иначе каждый новый readline теряет то, что предыдущий успел прочитать в буфер.
let queue;
function nextLine() {
  if (!queue) {
    queue = { lines: [], waiters: [], ended: false };
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (l) => (queue.waiters.length ? queue.waiters.shift().resolve(l) : queue.lines.push(l)));
    rl.on('close', () => {
      queue.ended = true;
      for (const w of queue.waiters.splice(0)) w.reject(new Error('ввод закончился раньше, чем мастер задал все вопросы'));
    });
  }
  if (queue.lines.length) return Promise.resolve(queue.lines.shift());
  if (queue.ended) return Promise.reject(new Error('ввод закончился раньше, чем мастер задал все вопросы'));
  return new Promise((resolve, reject) => queue.waiters.push({ resolve, reject }));
}

export async function ask(question, fallback = '') {
  const prompt = `${question}${fallback ? ` [${fallback}]` : ''}: `;
  let answer;
  if (interactive()) {
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    try {
      answer = await rl.question(prompt);
    } finally {
      rl.close();
    }
  } else {
    out.write(prompt);
    answer = await nextLine();
    out.write('\n');
  }
  return answer.trim() || fallback;
}

/** Скрытый ввод (звёздочки). Если консоль не интерактивная — обычный ввод с предупреждением. */
export function askSecret(question, { keepHint = false } = {}) {
  const suffix = keepHint ? ' (Enter — оставить сохранённый)' : '';
  if (!interactive() || typeof process.stdin.setRawMode !== 'function') {
    // из потока ничего не отображаем — значение не попадёт в журнал консоли
    out.write(`${question}${suffix}: `);
    return nextLine().then((v) => {
      out.write('(принято)\n');
      return v.trim();
    });
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = '';
    out.write(`${question}${suffix}: `);
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      out.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          reject(new Error('отменено'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            out.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        out.write('*');
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function confirm(question, fallback = true) {
  const answer = (await ask(`${question} (${fallback ? 'Д/н' : 'д/Н'})`)).toLowerCase();
  if (!answer) return fallback;
  return /^(д|да|y|yes)$/.test(answer);
}

/** Выбор из списка: options — [{ value, label }]. Возвращает value. */
export async function choose(question, options, fallbackIndex = 0) {
  out.write(`${question}\n`);
  options.forEach((o, i) => out.write(`  ${i + 1}) ${o.label}\n`));
  for (;;) {
    const answer = await ask('Номер', String(fallbackIndex + 1));
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    out.write(`  нужно число от 1 до ${options.length}\n`);
  }
}

export const say = (text = '') => out.write(`${text}\n`);
