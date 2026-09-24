/*
 * Проверка доставки сообщения в чат Клодиана.
 *
 * Дерево страницы здесь НАСТОЯЩЕЕ (jsdom), а не самодельная заглушка: проверяется
 * именно код плагина — как он ищет поле, как не трогает черновик, как убеждается,
 * что сообщение УШЛО, а не просто «нажал Enter» (§🧫 v3.34, §🎯 v2.85).
 *
 * Заглушка здесь одна и честная — сам Клодиан: слушает Enter и переносит текст
 * из поля в переписку. Это внешняя система, её и положено подменять.
 *
 * Запуск: node test/deliver.test.js
 */

'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const { internals } = require('./_load');
const { deliverText, findInput, isStreaming, countUserMessages } = internals;

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

// ── Поддельный Клодиан: окно с полем ввода и переписка ──────────────────────

function makeClaudian({ open = true, draft = '', streaming = false, requireMod = false, deaf = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;

  const addLeaf = (value = '') => {
    const leaf = doc.createElement('div');
    leaf.className = 'workspace-leaf-content';
    leaf.setAttribute('data-type', 'claudian-view');
    leaf.innerHTML =
      '<div class="claudian-tab-bar"></div>' +
      '<div class="claudian-messages"></div>' +
      '<div class="claudian-input-toolbar"></div>';
    const ta = doc.createElement('textarea');
    ta.className = 'claudian-input';
    ta.value = value;
    leaf.appendChild(ta);
    doc.body.appendChild(leaf);

    // Поведение настоящего Клодиана: Enter отправляет, текст уезжает в переписку.
    if (!deaf) {
      ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const modOk = requireMod ? (e.metaKey || e.ctrlKey) : true;
        if (!modOk) return;
        const text = ta.value;
        if (!text.trim()) return;
        ta.value = '';
        const msg = doc.createElement('div');
        msg.className = 'claudian-message-user';
        msg.textContent = text;
        leaf.querySelector('.claudian-messages').appendChild(msg);
      });
    }
    return { leaf, ta };
  };

  let first = null;
  if (open) first = addLeaf(draft);

  if (streaming && first) {
    const badge = doc.createElement('span');
    badge.className = 'claudian-tab-badge claudian-tab-badge-streaming';
    first.leaf.querySelector('.claudian-tab-bar').appendChild(badge);
  }

  const calls = [];
  const env = {
    doc,
    run: async (id) => {
      calls.push(id);
      if (id === 'realclaudian:open-view' && !doc.querySelector('.workspace-leaf-content')) addLeaf('');
      if (id === 'realclaudian:new-tab') addLeaf('');
    },
    sleep: async () => {},            // в тестах время не идёт — проверяем логику, не часы
    requireMod: false,                // плагин по умолчанию шлёт обычный Enter
    isMac: true,
    verifyTimeoutMs: 3000,
  };
  return { dom, doc, env, calls, first };
}

const userTexts = (doc) =>
  Array.from(doc.querySelectorAll('.claudian-message-user')).map(el => el.textContent);

(async () => {
  console.log('Доставка сообщения:');

  await t('обычная отправка в открытую вкладку', async () => {
    const { doc, env } = makeClaudian();
    const res = await deliverText(env, 'проверка связи', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.strictEqual(res.via, 'current');
    assert.deepStrictEqual(userTexts(doc), ['проверка связи'], 'сообщение должно появиться в переписке');
    assert.strictEqual(findInput(doc).value, '', 'поле должно опустеть');
  });

  await t('окно Клодиана закрыто — плагин открывает его сам', async () => {
    const { doc, env, calls } = makeClaudian({ open: false });
    const res = await deliverText(env, 'утренняя сводка', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.ok(calls.includes('realclaudian:open-view'), 'должна быть команда открытия окна');
    assert.deepStrictEqual(userTexts(doc), ['утренняя сводка']);
  });

  await t('агент печатает — не встреваем, просим повтор позже', async () => {
    const { doc, env } = makeClaudian({ streaming: true });
    const res = await deliverText(env, 'подожди', 'current');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.retry, true, 'это временная помеха, а не отказ');
    assert.deepStrictEqual(userTexts(doc), [], 'ничего не должно уйти');
  });

  await t('в поле набран черновик — он цел, сообщение уходит в новую вкладку', async () => {
    const { doc, env, calls, first } = makeClaudian({ draft: 'я тут пишу руками' });
    const res = await deliverText(env, 'отложенное', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.strictEqual(res.via, 'new', 'должно уйти в новую вкладку');
    assert.ok(calls.includes('realclaudian:new-tab'), 'должна быть команда новой вкладки');
    assert.strictEqual(first.ta.value, 'я тут пишу руками', 'черновик трогать нельзя');
    assert.deepStrictEqual(userTexts(doc), ['отложенное']);
  });

  await t('выбрана новая вкладка — открывается новая, старая не трогается', async () => {
    const { doc, env, calls } = makeClaudian();
    const res = await deliverText(env, 'в чистую', 'new');
    assert.strictEqual(res.ok, true);
    assert.ok(calls.includes('realclaudian:new-tab'));
    assert.strictEqual(doc.querySelectorAll('.workspace-leaf-content').length, 2);
    assert.deepStrictEqual(userTexts(doc), ['в чистую']);
  });

  await t('Клодиан ждёт Cmd+Enter — срабатывает страховка', async () => {
    const { doc, env } = makeClaudian({ requireMod: true });
    // плагин не знает про настройку (requireMod: false) — и всё равно должен дожать
    const res = await deliverText(env, 'через Cmd', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.deepStrictEqual(userTexts(doc), ['через Cmd']);
  });

  console.log('Отказы (тишины быть не должно):');

  await t('Клодиан не принял сообщение — честный отказ с причиной', async () => {
    const { doc, env } = makeClaudian({ deaf: true });
    const res = await deliverText(env, 'в пустоту', 'current');
    assert.strictEqual(res.ok, false, 'удачей это быть не может');
    assert.ok(res.reason && /не принял|не появилось/.test(res.reason), `нужна внятная причина, получено: ${res.reason}`);
    assert.deepStrictEqual(userTexts(doc), [], 'в переписке ничего не появилось');
    assert.strictEqual(findInput(doc).value, '', 'за собой мусор в поле не оставляем');
  });

  await t('окно не открылось совсем — отказ, а не молчание', async () => {
    const { env } = makeClaudian({ open: false });
    env.run = async () => {};   // команда открытия ничего не делает (Клодиан выключен)
    const res = await deliverText(env, 'некуда', 'current');
    assert.strictEqual(res.ok, false);
    assert.ok(/не открылось/.test(res.reason), `получено: ${res.reason}`);
  });

  console.log('Учение — проверка самой проверки:');

  await t('переименовали класс поля ввода — доставка падает, а не делает вид', async () => {
    const { doc, env } = makeClaudian();
    doc.querySelector('textarea.claudian-input').className = 'claudian-input-v3';
    env.run = async () => {};   // открыть заново нечего — класс сменился везде
    const res = await deliverText(env, 'при смене вёрстки', 'current');
    assert.strictEqual(res.ok, false, 'смена вёрстки Клодиана обязана ломать доставку явно');
  });

  console.log('Вспомогательное:');

  await t('isStreaming и countUserMessages смотрят в свою вкладку', async () => {
    const { doc, env } = makeClaudian({ streaming: true });
    const input = findInput(doc);
    assert.strictEqual(isStreaming(doc, input), true);
    assert.strictEqual(countUserMessages(doc, input), 0);
    await deliverText(Object.assign({}, env, { doc }), 'x', 'current');
    assert.strictEqual(countUserMessages(doc, input), 0);
  });

  console.log(`\nВсего зелёных: ${passed}`);
  if (process.exitCode) console.error('ЕСТЬ ПАДЕНИЯ'); else console.log('Все проверки прошли');
})();
