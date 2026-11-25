/*
 * Куда положить по умолчанию (решение владельца 26.11.2026):
 * новое сообщение — в чат, открытый сейчас, в том окне, откуда позвали;
 * сохранённая настройка «в тот, что будет открыт» больше не перебивает открытый чат.
 *
 * Запуск: node test/target.test.js
 */

'use strict';

const assert = require('assert');
const { internals } = require('./_load');
const { initialTarget } = internals;

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

const one = [
  { title: 'MF-36', win: 0, index: 0, active: false },
  { title: 'MF-37', win: 0, index: 1, active: true },
  { title: 'Zub-10', win: 0, index: 2, active: false },
];
const two = [
  { title: 'A', win: 0, index: 0, active: true },
  { title: 'B', win: 1, index: 0, active: false },
  { title: 'C', win: 1, index: 1, active: true },
];

console.log('Куда положить по умолчанию:');

t('настройка «будет открыт в момент отправки» — всё равно открытый сейчас чат', () => {
  assert.strictEqual(initialTarget(one, 'current', false, -1), 'tab:1');
});
t('старое значение «active» — открытый сейчас чат', () => {
  assert.strictEqual(initialTarget(one, 'active', false, -1), 'tab:1');
});
t('настройка «новая вкладка» не перебивает открытый чат', () => {
  assert.strictEqual(initialTarget(one, 'new', false, -1), 'tab:1');
});
t('два окна — открытый чат того окна, откуда позвали', () => {
  assert.strictEqual(initialTarget(two, 'current', false, 1), 'tab:2');
  assert.strictEqual(initialTarget(two, 'current', false, 0), 'tab:0');
});
t('окно не определили — первый открытый чат', () => {
  assert.strictEqual(initialTarget(two, 'current', false, -1), 'tab:0');
});
t('открытых чатов нет — действует настройка', () => {
  const none = one.map(x => ({ ...x, active: false }));
  assert.strictEqual(initialTarget(none, 'current', false, -1), 'current');
  assert.strictEqual(initialTarget(none, 'new', false, -1), 'new');
  assert.strictEqual(initialTarget([], 'current', false, -1), 'current');
});
t('перенос: сохранённый чат не меняем на открытый', () => {
  assert.strictEqual(initialTarget(one, { title: 'Zub-10', win: 0 }, true, -1), 'tab:2');
  assert.strictEqual(initialTarget(one, 'current', true, -1), 'current');
  assert.strictEqual(initialTarget(one, 'new', true, -1), 'new');
});

console.log(`\n${passed} проверок прошло`);
