/*
 * Клодиан 2.3.39+ — новое поле ввода (DIV с редактором) и новые следы доставки.
 *
 * Поломка 25.11.2026: с 06.11 отложенные сообщения не уходили — плагин искал
 * textarea.claudian-input, а поле стало DIV. В журнале: «окно Клодиана ещё не открылось»
 * 20 раз подряд, сообщения 04:00 и 05:00 потеряны. Последняя удачная отправка — 06.11 12:02.
 *
 * Поддельный Клодиан здесь повторяет 2.3.48, сверенный по коду 25.11.2026:
 * DIV.claudian-input с собственным свойством value, keydown на нём же с перехватом,
 * очередь — span.claudian-queue-indicator-text. Журнал сессии — в формате настоящего
 * ~/.claude/projects/*.jsonl (строки сверены с живым журналом 25.11.2026).
 *
 * Запуск: node test/composer-div.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { internals } = require('./_load');
const { makeClaudian } = require('./_claudian');
const { deliverText, activeInput, findClaudeSessionRecord, claudeProjectDir } = internals;

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {
  console.log('Новое поле ввода (DIV, Клодиан 2.3.39+):');

  await t('поле находится, хотя это не textarea', async () => {
    const c = makeClaudian({ composer: 'div' });
    const el = activeInput(c.env.roots());
    assert.ok(el, 'поле ввода должно найтись');
    assert.strictEqual(el.tagName, 'DIV');
  });

  await t('сообщение уходит и появляется в переписке', async () => {
    const c = makeClaudian({ composer: 'div' });
    const res = await deliverText(c.env, 'продолжи делать счёт с печатью', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.strictEqual(res.note, 'отправлено');
    assert.deepStrictEqual(c.userTexts(), ['продолжи делать счёт с печатью']);
    assert.deepStrictEqual(c.presses, ['продолжи делать счёт с печатью'], 'ровно одно нажатие — без двойной отправки');
  });

  await t('занятый агент — сообщение распознаётся в новой полосе очереди', async () => {
    const c = makeClaudian({ composer: 'div', busy: true });
    const res = await deliverText(c.env, 'посчитай остатки', 'current');
    assert.strictEqual(res.ok, true, `очередь — это успех, получено: ${res.reason}`);
    assert.ok(/очеред/.test(res.note), `в пометке должна быть очередь, получено: ${res.note}`);
  });

  await t('черновик в поле цел — сообщение уходит в новую вкладку', async () => {
    const c = makeClaudian({ composer: 'div' });
    c.tabs[0].ta.value = 'я тут пишу руками';
    const res = await deliverText(c.env, 'отложенное', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.strictEqual(res.via, 'new');
    assert.strictEqual(c.tabs[0].ta.value, 'я тут пишу руками', 'черновик трогать нельзя');
    assert.deepStrictEqual(c.userTexts(), ['отложенное']);
  });

  await t('скрытые вкладки не берутся: сообщение ложится в видимую', async () => {
    const c = makeClaudian({ composer: 'div' });
    c.addTab(0);                       // вторая вкладка видна, первая спрятана классом
    const res = await deliverText(c.env, 'в видимую', 'current');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(c.tabs[0].messages.children.length, 0, 'в спрятанную вкладку класть нельзя');
  });

  console.log('Журнал сессии Claude Code как доказательство доставки:');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-jsonl-'));
  const NOW = Date.now();
  const SINCE = NOW - 5000;
  const iso = (ms) => new Date(ms).toISOString();
  const line = (o) => JSON.stringify(o);
  const user = (text, at, extra = {}) => line({ type: 'user', sessionId: 'sess-1', timestamp: iso(at), message: { role: 'user', content: text }, ...extra });

  // настоящий журнал: длинная история, в конце наше сообщение с пометками Клодиана
  const filler = 'x'.repeat(1500);
  const body = [
    line({ type: 'assistant', timestamp: iso(NOW - 90000), message: { content: [{ type: 'text', text: filler }] } }),
    user('продолжи делать задачи из бэклога', NOW - 86400000),                  // вчерашнее — не наше
    user('продолжи делать задачи из бэклога', NOW - 900, { isMeta: true }),     // служебное — не считается
    user('продолжи делать задачи из бэклога по очереди\n\n<editor_cursor path="x.md" line="3">…</editor_cursor>', NOW - 800),
    line({ type: 'user', sessionId: 'sess-1', timestamp: iso(NOW - 700), message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'чини отложенную отправку' }] } }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), body, 'utf8');
  fs.writeFileSync(path.join(dir, 'старый.jsonl'), user('посчитай остатки', NOW - 1000) + '\n', 'utf8');
  fs.utimesSync(path.join(dir, 'старый.jsonl'), new Date(NOW - 3600000), new Date(NOW - 3600000));
  fs.writeFileSync(path.join(dir, 'битый.jsonl'), '{ это не json\n', 'utf8');

  await t('свежее сообщение с пометками Клодиана находится по началу текста', async () => {
    const r = findClaudeSessionRecord(fs, path, dir, 'продолжи делать задачи из бэклога по очереди', SINCE);
    assert.ok(r, 'запись должна найтись');
    assert.strictEqual(r.where, 'sess-1');
  });

  await t('сообщение из частей (картинка + текст) находится', async () => {
    const r = findClaudeSessionRecord(fs, path, dir, 'чини отложенную отправку', SINCE);
    assert.ok(r, 'запись должна найтись');
  });

  await t('вчерашнее и служебное с тем же текстом — НЕ наше', async () => {
    const r = findClaudeSessionRecord(fs, path, dir, 'продолжи делать задачи из бэклога из прошлого', SINCE);
    assert.strictEqual(r, null);
    const only = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-jsonl-old-'));
    fs.writeFileSync(path.join(only, 'a.jsonl'), [
      user('продолжи делать задачи из бэклога', NOW - 86400000),
      user('продолжи делать задачи из бэклога', NOW - 900, { isMeta: true }),
    ].join('\n') + '\n', 'utf8');
    assert.strictEqual(findClaudeSessionRecord(fs, path, only, 'продолжи делать задачи из бэклога', SINCE), null);
    fs.rmSync(only, { recursive: true, force: true });
  });

  await t('файл не менялся после отправки — не смотрится вовсе', async () => {
    assert.strictEqual(findClaudeSessionRecord(fs, path, dir, 'посчитай остатки', SINCE), null);
  });

  await t('хвост обрезан посреди строки и битый файл — без падения, запись всё равно находится', async () => {
    const r = findClaudeSessionRecord(fs, path, dir, 'чини отложенную отправку', SINCE, 400);
    assert.ok(r, 'последняя целая строка должна разобраться');
  });

  await t('пустой текст ничего не «находит»', async () => {
    assert.strictEqual(findClaudeSessionRecord(fs, path, dir, '   ', SINCE), null);
  });

  await t('папка журналов вычисляется так же, как у Claude Code', async () => {
    assert.strictEqual(
      claudeProjectDir(path, '/Users/vadimfedorov', '/Users/vadimfedorov/Obsidian/Vault'),
      '/Users/vadimfedorov/.claude/projects/-Users-vadimfedorov-Obsidian-Vault',
    );
  });

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\nВсего зелёных: ${passed}`);
  if (process.exitCode) console.error('ЕСТЬ ПАДЕНИЯ'); else console.log('Все проверки прошли');
})();
