/*
 * Проверка очереди и просрочки — решение владельца 24.09.2026:
 * опоздание меньше 12 часов → отправить, больше → «просрочено».
 *
 * Здесь работает НАСТОЯЩИЙ класс плагина: его startupCheck, tick и fire.
 * Подменены только границы с Обсидианом (сохранение настроек, всплывающие окна,
 * журнал) и сам Клодиан — заготовкой, повторяющей его настоящее устройство.
 *
 * Запуск: node test/overdue.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { internals, notices } = require('./_load');
const { makeClaudian } = require('./_claudian');
const Plugin = require(path.join(__dirname, '..', 'main.js'));
const { DEFAULTS, MAX_ATTEMPTS } = internals;

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

/** Плагин с настоящей логикой, но без Обсидиана вокруг. */
function makePlugin(items, claudianOpts = {}) {
  const c = makeClaudian(claudianOpts);
  const p = new Plugin();
  p.settings = Object.assign({}, DEFAULTS);
  p.items = items;
  p.working = false;
  p.saved = 0;
  p.logs = [];
  p.saveData = async () => { p.saved++; };
  p.renderStatus = () => {};
  p.log = (line) => p.logs.push(line);
  p.env = () => c.env;
  p.claudian = c;
  return p;
}

const HOUR = 3600000;
const item = (over, extra = {}) => Object.assign({
  id: 'i' + over + Math.random().toString(36).slice(2, 6),
  text: `сообщение (опоздание ${over} ч)`,
  fireAt: Date.now() - over * HOUR,
  target: 'current',
  createdAt: Date.now() - 86400000,
  status: 'pending',
  attempts: 0,
}, extra);

(async () => {
  console.log('Обсидиан был закрыт:');

  await t('опоздание 3 часа — сообщение уходит при запуске', async () => {
    const p = makePlugin([item(3)]);
    await p.startupCheck();
    assert.deepStrictEqual(p.claudian.userTexts(), ['сообщение (опоздание 3 ч)']);
    assert.strictEqual(p.items[0].status, 'sent');
  });

  await t('опоздание 13 часов — «просрочено», в чат НЕ уходит', async () => {
    notices.length = 0;
    const p = makePlugin([item(13)]);
    await p.startupCheck();
    assert.deepStrictEqual(p.claudian.userTexts(), []);
    assert.strictEqual(p.items[0].status, 'missed');
    assert.ok(notices.some(n => /не ушло/.test(n)), 'владельцу должны сказать, а не промолчать');
  });

  await t('время ещё не пришло — сообщение ждёт', async () => {
    const p = makePlugin([item(0, { fireAt: Date.now() + 2 * HOUR })]);
    await p.startupCheck();
    assert.deepStrictEqual(p.claudian.userTexts(), []);
    assert.strictEqual(p.items[0].status, 'pending');
  });

  await t('оборванный прошлый сеанс («отправляется») — сообщение не теряется', async () => {
    const p = makePlugin([item(1, { status: 'sending' })]);
    await p.startupCheck();
    assert.strictEqual(p.items[0].status, 'sent');
  });

  console.log('Мак просыпается (находка ревизии — раньше запас не действовал):');

  await t('проснулись через 20 часов — запас 12 ч действует и БЕЗ перезапуска Обсидиана', async () => {
    const p = makePlugin([item(20)]);
    await p.tick();        // именно тик, а не startupCheck: после сна Обсидиан не перезагружается
    assert.strictEqual(p.items[0].status, 'missed', 'запас должен проверяться в обычном ходе часов');
    assert.deepStrictEqual(p.claudian.userTexts(), [], 'сутки спустя сообщение отправлять нельзя');
  });

  await t('проснулись через 2 часа — сообщение уходит', async () => {
    const p = makePlugin([item(2)]);
    await p.tick();
    assert.strictEqual(p.items[0].status, 'sent');
  });

  console.log('Повторные срабатывания и замок:');

  await t('три тика подряд — сообщение уходит РОВНО один раз', async () => {
    const p = makePlugin([item(1)]);
    await p.tick(); await p.tick(); await p.tick();
    assert.strictEqual(p.claudian.userTexts().length, 1);
  });

  await t('«Отправить сейчас» во время работы часов — отказывается, дубля нет', async () => {
    const p = makePlugin([item(1)]);
    p.working = true;                       // часы сейчас заняты отправкой
    await p.fireNow(p.items[0]);
    assert.deepStrictEqual(p.claudian.userTexts(), [], 'мимо замка лезть нельзя');
    p.working = false;
    await p.fireNow(p.items[0]);
    assert.strictEqual(p.claudian.userTexts().length, 1);
  });

  await t('занятый агент — сообщение уходит в очередь Клодиана и считается доставленным', async () => {
    const p = makePlugin([item(1)], { busy: true });
    await p.tick();
    assert.strictEqual(p.items[0].status, 'sent');
    assert.ok(/очеред/.test(p.items[0].note), `получено: ${p.items[0].note}`);
  });

  console.log('Помехи не превращаются ни в потерю, ни в вечный круг:');

  await t('Клодиан ещё не поднялся — сообщение ЖДЁТ, а не помечается «не удалось»', async () => {
    const p = makePlugin([item(1)], { open: false, canOpen: false });
    await p.tick();
    assert.strictEqual(p.items[0].status, 'pending', 'временная помеха не должна терять сообщение');
    assert.ok(/попытка 1/.test(p.items[0].note), `получено: ${p.items[0].note}`);
  });

  await t(`после ${MAX_ATTEMPTS} попыток сдаёмся и говорим об этом`, async () => {
    const p = makePlugin([item(1)], { open: false, canOpen: false });
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await p.tick();
    assert.strictEqual(p.items[0].status, 'failed');
    assert.ok(/попыт/.test(p.items[0].note), `получено: ${p.items[0].note}`);
  });

  await t('сбой доставки не оставляет сообщение в «отправляется» навсегда', async () => {
    const p = makePlugin([item(1)]);
    p.env = () => { throw new Error('окно сломалось'); };
    await p.tick();
    assert.strictEqual(p.items[0].status, 'failed');
    assert.ok(/сбой/.test(p.items[0].note));
  });

  await t('испорченное время в файле — сообщение не крутится вечно', async () => {
    const p = makePlugin([item(1, { fireAt: NaN })]);
    await p.tick();
    assert.strictEqual(p.items[0].status, 'failed');
    assert.ok(/испорчен/.test(p.items[0].note), `получено: ${p.items[0].note}`);
  });

  console.log('Мусор в настройках не ломает часы:');

  await t('checkSec строкой — период остаётся разумным числом', async () => {
    const p = makePlugin([]);
    p.settings.checkSec = 'abc';
    p.settings.graceHours = null;
    assert.strictEqual(p.grace(), DEFAULTS.graceHours);
    const { num } = internals;
    assert.strictEqual(num('abc', 20, 5, 300), 20);
    assert.strictEqual(num(10000, 20, 5, 300), 300);
  });

  console.log(`\nВсего зелёных: ${passed}`);
  if (process.exitCode) console.error('ЕСТЬ ПАДЕНИЯ'); else console.log('Все проверки прошли');
})();
