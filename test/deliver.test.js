/*
 * Проверка доставки сообщения в чат Клодиана.
 *
 * Дерево страницы настоящее (jsdom), поддельный Клодиан (test/_claudian.js) повторяет
 * устройство сборки 2.2.6 — вкладки в одном окне, очередь при занятом агенте,
 * атрибут data-role, асинхронная отправка.
 *
 * Половина проверок здесь появилась после ревизии 24.09.2026, которая показала:
 * прежняя заготовка повторяла мои домыслы и потому была зелёной при сломанной защите.
 *
 * Запуск: node test/deliver.test.js
 */

'use strict';

const assert = require('assert');
const { internals } = require('./_load');
const { makeClaudian } = require('./_claudian');
const { deliverText, activeInput, countUserMessages, sendOutcome, tabOf } = internals;

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {
  console.log('Доставка:');

  await t('обычная отправка в открытую вкладку', async () => {
    const c = makeClaudian();
    const res = await deliverText(c.env, 'проверка связи', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.strictEqual(res.via, 'current');
    assert.strictEqual(res.note, 'отправлено');
    assert.deepStrictEqual(c.userTexts(), ['проверка связи']);
  });

  await t('окно Клодиана закрыто — плагин открывает его сам', async () => {
    const c = makeClaudian({ open: false });
    const res = await deliverText(c.env, 'утренняя сводка', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.ok(c.calls.includes('open-view'));
    assert.deepStrictEqual(c.userTexts(), ['утренняя сводка']);
  });

  await t('в поле набран черновик — он цел, сообщение уходит в новую вкладку', async () => {
    const c = makeClaudian();
    c.tabs[0].ta.value = 'я тут пишу руками';
    const res = await deliverText(c.env, 'отложенное', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.strictEqual(res.via, 'new');
    assert.strictEqual(c.tabs[0].ta.value, 'я тут пишу руками', 'черновик трогать нельзя');
    assert.deepStrictEqual(c.userTexts(), ['отложенное']);
  });

  await t('выбрана новая вкладка — сообщение легло ИМЕННО в неё', async () => {
    const c = makeClaudian();
    const res = await deliverText(c.env, 'в чистую', 'new');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(c.tabs.length, 2, 'должна появиться вторая вкладка');
    const inOld = c.tabs[0].messages.querySelectorAll('[data-role="user"]').length;
    const inNew = c.tabs[1].messages.querySelectorAll('[data-role="user"]').length;
    assert.strictEqual(inOld, 0, 'в старую вкладку класть было нельзя');
    assert.strictEqual(inNew, 1, 'сообщение должно быть в новой вкладке');
  });

  console.log('Занятый агент (Клодиан ставит в очередь сам):');

  await t('агент пишет ответ — сообщение попадает в очередь, это УСПЕХ, а не отказ', async () => {
    const c = makeClaudian({ busy: true });
    const res = await deliverText(c.env, 'посчитай остатки', 'current');
    assert.strictEqual(res.ok, true, `очередь — это успех, получено: ${res.reason}`);
    assert.ok(/очеред/.test(res.note), `в пометке должна быть очередь, получено: ${res.note}`);
    assert.ok(c.queueTexts().some(q => q.includes('посчитай остатки')), 'сообщение должно стоять в очереди Клодиана');
  });

  console.log('Двойная отправка (находка ревизии):');

  await t('отправка доходит с задержкой — сообщение уходит РОВНО один раз', async () => {
    // Клодиан принимает и простой Enter, и Cmd+Enter; настройку плагин прочитал
    const c = makeClaudian({ sendDelay: 12 });
    c.env.modKnown = true;
    c.env.requireMod = false;
    const res = await deliverText(c.env, 'медленная отправка', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.strictEqual(c.presses.length, 1, `нажатие должно быть одно, было: ${c.presses.length}`);
    assert.deepStrictEqual(c.userTexts(), ['медленная отправка'], 'дубля быть не должно');
  });

  await t('настройку прочитать не удалось, Клодиан ждёт Cmd+Enter — страховка срабатывает', async () => {
    const c = makeClaudian({ requireMod: true });   // простой Enter Клодиан игнорирует
    c.env.modKnown = false;
    const res = await deliverText(c.env, 'через Cmd', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.deepStrictEqual(c.userTexts(), ['через Cmd']);
  });

  await t('настройка известна — второго нажатия не делаем даже при задержке', async () => {
    const c = makeClaudian({ sendDelay: 20 });
    c.env.modKnown = true;
    await deliverText(c.env, 'без страховки', 'current');
    assert.strictEqual(c.presses.length, 1);
  });

  console.log('Соседние вкладки и второе окно:');

  await t('сообщения соседней (скрытой) вкладки не считаются нашей отправкой', async () => {
    const c = makeClaudian({ deaf: true });     // Клодиан не примет наше сообщение
    // в скрытой соседней вкладке «появляется» чужое сообщение
    const other = c.addTab(0);                  // новая вкладка активна, прежняя скрыта
    const msg = c.doc.createElement('div');
    msg.setAttribute('data-role', 'user');
    msg.textContent = 'чужое сообщение';
    c.tabs[0].messages.appendChild(msg);
    const res = await deliverText(c.env, 'наше сообщение', 'current');
    assert.strictEqual(res.ok, false, 'чужое сообщение в соседней вкладке — не наш успех');
    assert.ok(other, 'вкладка создана');
  });

  await t('Клодиан открыт в оторванном окне — плагин его находит', async () => {
    const c = makeClaudian({ open: false, popout: true });
    const res = await deliverText(c.env, 'во втором окне', 'current');
    assert.strictEqual(res.ok, true, `ожидалась удача, получено: ${res.reason}`);
    assert.deepStrictEqual(c.userTexts(), ['во втором окне']);
  });

  console.log('Отказы и помехи (тишины быть не должно):');

  await t('Клодиан не принял сообщение — честный отказ, поле очищено', async () => {
    const c = makeClaudian({ deaf: true });
    const res = await deliverText(c.env, 'в пустоту', 'current');
    assert.strictEqual(res.ok, false);
    assert.ok(/не принял/.test(res.reason), `нужна внятная причина, получено: ${res.reason}`);
    assert.deepStrictEqual(c.userTexts(), []);
    assert.strictEqual(activeInput(c.env.roots()).value, '', 'мусор в поле не оставляем');
  });

  await t('окно не открылось — это ПОМЕХА (вернёмся позже), а не окончательный отказ', async () => {
    const c = makeClaudian({ open: false, canOpen: false });
    const res = await deliverText(c.env, 'некуда', 'current');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.retry, true, 'сообщение не должно пропасть навсегда');
  });

  await t('Клодиан отказал в новой вкладке — кладём в свободную и честно помечаем', async () => {
    const c = makeClaudian({ canNewTab: false });
    const res = await deliverText(c.env, 'в новую', 'new');
    assert.strictEqual(res.ok, true, 'держать сообщение из-за предела вкладок незачем');
    assert.ok(/не вышло/.test(res.note), `в пометке должно быть сказано, получено: ${res.note}`);
    assert.deepStrictEqual(c.userTexts(), ['в новую']);
  });

  await t('предел вкладок И черновик в поле — сообщение ждёт, черновик цел', async () => {
    const c = makeClaudian({ canNewTab: false });
    c.tabs[0].ta.value = 'черновик Вадима';
    const res = await deliverText(c.env, 'отложенное', 'current');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.retry, true, 'сообщение должно вернуться на следующем тике');
    assert.strictEqual(c.tabs[0].ta.value, 'черновик Вадима', 'черновик трогать нельзя даже так');
  });

  console.log('Учения — проверка самой проверки:');

  await t('переименовали класс поля ввода — доставка падает, а не делает вид', async () => {
    const c = makeClaudian();
    c.tabs[0].ta.className = 'claudian-input-v3';
    c.env.run = async () => false;
    const res = await deliverText(c.env, 'при смене вёрстки', 'current');
    assert.strictEqual(res.ok, false, 'смена вёрстки Клодиана обязана ломать доставку явно');
  });

  await t('убрали строку очереди — занятый агент перестаёт давать ложный успех', async () => {
    const c = makeClaudian({ busy: true });
    c.tabs[0].queue.className = 'claudian-input-queue-row-v3';
    const res = await deliverText(c.env, 'проверка учения', 'current');
    assert.strictEqual(res.ok, false, 'без видимой очереди подтверждения нет');
  });

  console.log('Вспомогательное:');

  await t('countUserMessages и tabOf смотрят в свою вкладку', async () => {
    const c = makeClaudian();
    const input = activeInput(c.env.roots());
    assert.strictEqual(countUserMessages(input), 0);
    assert.ok(tabOf(input).classList.contains('claudian-tab-content'));
    assert.strictEqual(sendOutcome(input, 'ничего', 0), null);
  });

  console.log(`\nВсего зелёных: ${passed}`);
  if (process.exitCode) console.error('ЕСТЬ ПАДЕНИЯ'); else console.log('Все проверки прошли');
})();
