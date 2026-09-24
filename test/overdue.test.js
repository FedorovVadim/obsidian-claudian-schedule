/*
 * Проверка поведения после закрытого Обсидиана — решение владельца 24.09.2026:
 * опоздание меньше 12 часов → отправить при запуске, больше → «просрочено».
 *
 * Здесь работает НАСТОЯЩИЙ класс плагина: его startupCheck, tick и fire.
 * Подменены только границы с Обсидианом (сохранение настроек, всплывающие окна,
 * журнал) — само дерево страницы настоящее (jsdom), доставка идёт полным путём.
 *
 * Запуск: node test/overdue.test.js
 */

'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const path = require('path');
const { internals, notices } = require('./_load');
const Plugin = require(path.join(__dirname, '..', 'main.js'));
const { DEFAULTS } = internals;

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

/** Плагин с настоящей логикой, но без Обсидиана вокруг. */
function makePlugin(items, { streaming = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;

  const addLeaf = (busy = false) => {
    const leaf = doc.createElement('div');
    leaf.className = 'workspace-leaf-content';
    leaf.setAttribute('data-type', 'claudian-view');
    leaf.innerHTML = '<div class="claudian-tab-bar">' +
      (busy ? '<span class="claudian-tab-badge-streaming"></span>' : '') +
      '</div><div class="claudian-messages"></div>';
    const ta = doc.createElement('textarea');
    ta.className = 'claudian-input';
    leaf.appendChild(ta);
    doc.body.appendChild(leaf);
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !ta.value.trim()) return;
      const msg = doc.createElement('div');
      msg.className = 'claudian-message-user';
      msg.textContent = ta.value;
      ta.value = '';
      leaf.querySelector('.claudian-messages').appendChild(msg);
    });
    return leaf;
  };
  addLeaf(streaming);

  const p = new Plugin();
  p.settings = Object.assign({}, DEFAULTS);
  p.items = items;
  p.busySince = new Map();
  p.working = false;
  p.saved = 0;
  p.notices = [];
  p.logs = [];

  p.saveData = async () => { p.saved++; };
  p.renderStatus = () => {};
  p.log = (line) => p.logs.push(line);
  p.env = () => ({
    doc,
    run: async (id) => { if (id === 'realclaudian:new-tab') addLeaf(false); },
    sleep: async () => {},
    requireMod: false,
    isMac: true,
    verifyTimeoutMs: 2000,
  });

  p._doc = doc;
  return p;
}

const HOUR = 3600000;
const userTexts = (doc) => Array.from(doc.querySelectorAll('.claudian-message-user')).map(e => e.textContent);
const item = (over) => ({
  id: 'i' + over, text: `сообщение (опоздание ${over} ч)`, fireAt: Date.now() - over * HOUR,
  target: 'current', createdAt: Date.now() - 86400000, status: 'pending', attempts: 0,
});

(async () => {
  console.log('Обсидиан был закрыт:');

  await t('опоздание 3 часа — сообщение уходит при запуске', async () => {
    const p = makePlugin([item(3)]);
    await p.startupCheck();
    assert.deepStrictEqual(userTexts(p._doc), ['сообщение (опоздание 3 ч)']);
    assert.strictEqual(p.items[0].status, 'sent');
  });

  await t('опоздание 13 часов — «просрочено», в чат НЕ уходит', async () => {
    notices.length = 0;
    const p = makePlugin([item(13)]);
    await p.startupCheck();
    assert.deepStrictEqual(userTexts(p._doc), [], 'в чат ничего уйти не должно');
    assert.strictEqual(p.items[0].status, 'missed');
    assert.ok(notices.some(n => /не ушло/.test(n)), 'владельцу должны сказать, а не промолчать');
  });

  await t('время ещё не пришло — сообщение ждёт, ничего не отправляется', async () => {
    const p = makePlugin([{ ...item(0), fireAt: Date.now() + 2 * HOUR }]);
    await p.startupCheck();
    assert.deepStrictEqual(userTexts(p._doc), []);
    assert.strictEqual(p.items[0].status, 'pending');
  });

  await t('оборванный прошлый сеанс (статус «отправляется») — сообщение не теряется', async () => {
    const p = makePlugin([{ ...item(1), status: 'sending' }]);
    await p.startupCheck();
    assert.strictEqual(p.items[0].status, 'sent', 'подвисшее сообщение должно уйти, а не застрять');
    assert.deepStrictEqual(userTexts(p._doc), ['сообщение (опоздание 1 ч)']);
  });

  console.log('Повторные срабатывания:');

  await t('два тика подряд — сообщение уходит РОВНО один раз', async () => {
    const p = makePlugin([item(1)]);
    await p.tick();
    await p.tick();
    await p.tick();
    assert.strictEqual(userTexts(p._doc).length, 1, 'дубля быть не должно');
  });

  await t('агент занят — сообщение остаётся в очереди, а не теряется и не падает', async () => {
    const p = makePlugin([item(1)], { streaming: true });
    await p.tick();
    assert.strictEqual(p.items[0].status, 'pending', 'ждём следующего тика');
    assert.deepStrictEqual(userTexts(p._doc), []);
    assert.ok(p.logs.some(l => /ждём/.test(l)), 'ожидание должно попасть в журнал');
  });

  await t('ждали дольше положенного — сообщение уходит в новую вкладку, а не висит вечно', async () => {
    const p = makePlugin([item(1)], { streaming: true });
    await p.tick();                                   // первый подход: занят, начали ждать
    assert.strictEqual(p.items[0].status, 'pending');
    // отматываем начало ожидания на 11 минут назад — предел 10
    p.busySince.set(p.items[0].id, Date.now() - 11 * 60000);
    await p.tick();
    assert.strictEqual(p.items[0].status, 'sent', 'после предела ожидания должно уйти');
    assert.strictEqual(userTexts(p._doc).length, 1);
    assert.strictEqual(p.items[0].note, 'ушло в новую вкладку');
  });

  await t('кнопка «Отправить сейчас» при занятом агенте не ждёт — сразу новая вкладка', async () => {
    const p = makePlugin([item(1)], { streaming: true });
    await p.fireNow(p.items[0]);
    assert.strictEqual(p.items[0].status, 'sent');
    assert.strictEqual(p.items[0].note, 'ушло в новую вкладку');
  });

  await t('сбой доставки не оставляет сообщение в «отправляется» навсегда', async () => {
    const p = makePlugin([item(1)]);
    p.env = () => { throw new Error('окно сломалось'); };
    await p.tick();
    assert.strictEqual(p.items[0].status, 'failed');
    assert.ok(/сбой/.test(p.items[0].note), `нужна причина, получено: ${p.items[0].note}`);
  });

  console.log(`\nВсего зелёных: ${passed}`);
  if (process.exitCode) console.error('ЕСТЬ ПАДЕНИЯ'); else console.log('Все проверки прошли');
})();
