/*
 * Проверка разбора времени.
 *
 * Главное, что здесь проверяется: непонятный ввод даёт ОШИБКУ, а не молчаливое
 * «отправлю сейчас» (§🤐 v3.35), и «18:00» в семь вечера — это завтра, а не прошлое.
 *
 * Запуск: node test/when.test.js
 */

'use strict';

const assert = require('assert');
const { internals } = require('./_load');
const { parseWhen, formatWhen, humanLeft, decideOverdue, shortText } = internals;

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

// Опорная точка: среда 24.09.2026, 14:30 по местному времени.
const NOW = new Date(2026, 8, 24, 14, 30, 0, 0).getTime();
const at = (raw) => parseWhen(raw, NOW);
const asDate = (raw) => new Date(at(raw).at);

console.log('Разбор времени:');

t('«через 30 минут»', () => {
  assert.strictEqual(at('через 30 минут').at, NOW + 30 * 60000);
});

t('«через 2 часа»', () => {
  assert.strictEqual(at('через 2 часа').at, NOW + 2 * 3600000);
});

t('«через 1,5 часа» — дробное через запятую', () => {
  assert.strictEqual(at('через 1,5 часа').at, NOW + 90 * 60000);
});

t('«через 3 дня»', () => {
  assert.strictEqual(at('через 3 дня').at, NOW + 3 * 86400000);
});

t('«через 15» без единицы = минуты', () => {
  assert.strictEqual(at('через 15').at, NOW + 15 * 60000);
});

t('«сегодня 18:00»', () => {
  const d = asDate('сегодня 18:00');
  assert.strictEqual(d.getDate(), 24);
  assert.strictEqual(d.getHours(), 18);
  assert.strictEqual(d.getMinutes(), 0);
});

t('«завтра в 9:00»', () => {
  const d = asDate('завтра в 9:00');
  assert.strictEqual(d.getDate(), 25);
  assert.strictEqual(d.getHours(), 9);
});

t('«послезавтра 7:30»', () => {
  const d = asDate('послезавтра 7:30');
  assert.strictEqual(d.getDate(), 26);
  assert.strictEqual(d.getMinutes(), 30);
});

t('«18:00» без дня — это сегодня, оно ещё впереди', () => {
  const d = asDate('18:00');
  assert.strictEqual(d.getDate(), 24);
  assert.strictEqual(d.getHours(), 18);
});

t('«9:00» без дня в 14:30 — это ЗАВТРА, а не прошлое', () => {
  const d = asDate('9:00');
  assert.strictEqual(d.getDate(), 25, 'утро уже прошло — значит следующее утро');
  assert.strictEqual(d.getHours(), 9);
});

t('«26.09 18:30»', () => {
  const d = asDate('26.09 18:30');
  assert.strictEqual(d.getDate(), 26);
  assert.strictEqual(d.getMonth(), 8);
  assert.strictEqual(d.getHours(), 18);
});

t('«01.01» в сентябре — это следующий год, а не прошедший январь', () => {
  const d = asDate('01.01 9:00');
  assert.strictEqual(d.getFullYear(), 2027);
});

t('«2026-09-25 07:15» — машинная запись', () => {
  const d = asDate('2026-09-25 07:15');
  assert.strictEqual(d.getDate(), 25);
  assert.strictEqual(d.getHours(), 7);
  assert.strictEqual(d.getMinutes(), 15);
});

console.log('Отказы (молчаливого успеха быть не должно):');

t('пустая строка — ошибка', () => {
  assert.ok(at('').error, 'должна быть ошибка');
});

t('мусор — ошибка, а не «сейчас»', () => {
  const r = at('когда-нибудь потом');
  assert.ok(r.error, 'должна быть ошибка');
  assert.strictEqual(r.at, undefined, 'времени быть не должно');
});

t('«сегодня 9:00» в 14:30 — ошибка «уже прошло», а не отправка в прошлое', () => {
  const r = at('сегодня 9:00');
  assert.ok(r.error && /прошл/.test(r.error), `ожидалось «уже прошло», получено: ${r.error}`);
});

t('«25:00» — таких часов не бывает', () => {
  assert.ok(at('25:00').error);
});

t('«через 0 минут» — ошибка', () => {
  assert.ok(at('через 0 минут').error);
});

t('«через 5 вёдер» — непонятная единица', () => {
  assert.ok(at('через 5 вёдер').error);
});

// ── Находка ревизии 24.09.2026: эти входы проходили молча ──
// «24.09 25:00» превращалось в завтра 01:00, «32.13» — в февраль 2027,
// а «через 9999999999 часов» давало NaN: запись висела вечно и не отправлялась.

t('«24.09 25:00» — 25 часов не бывает, а не «завтра в час ночи»', () => {
  const r = at('24.09 25:00');
  assert.ok(r.error, `ожидалась ошибка, получено время ${r.at && new Date(r.at)}`);
});

t('«32.13 10:00» — такой даты нет', () => {
  assert.ok(at('32.13 10:00').error);
});

t('«31.02 10:00» — февраль так не умеет', () => {
  assert.ok(at('31.02 10:00').error);
});

t('«99.99» — мусор, а не июнь 2034', () => {
  assert.ok(at('99.99').error);
});

t('«2026-09-24 99:00» — часы не бывают 99', () => {
  assert.ok(at('2026-09-24 99:00').error);
});

t('«через 9999999999 часов» — не NaN, а внятный отказ', () => {
  const r = at('через 9999999999 часов');
  assert.ok(r.error, 'должна быть ошибка');
  assert.ok(r.at === undefined || isFinite(r.at), 'NaN наружу выходить не должен');
});

t('«через 100 дней» — дальнее, но разумное время принимается', () => {
  const r = at('через 100 дней');
  assert.ok(!r.error && isFinite(r.at), `получено: ${r.error}`);
});

t('«завтра 25:00» — отказ, а не переползание на послезавтра', () => {
  assert.ok(at('завтра 25:00').error);
});

console.log('Показ времени:');

t('formatWhen: сегодня / завтра / дата', () => {
  assert.strictEqual(formatWhen(new Date(2026, 8, 24, 18, 0).getTime(), NOW), 'сегодня в 18:00');
  assert.strictEqual(formatWhen(new Date(2026, 8, 25, 9, 5).getTime(), NOW), 'завтра в 09:05');
  assert.strictEqual(formatWhen(new Date(2026, 8, 30, 8, 0).getTime(), NOW), '30.09 в 08:00');
});

t('humanLeft: вперёд и назад', () => {
  assert.strictEqual(humanLeft(NOW + 5 * 60000, NOW), 'через 5 мин');
  assert.strictEqual(humanLeft(NOW + 130 * 60000, NOW), 'через 2 ч 10 мин');
  assert.strictEqual(humanLeft(NOW - 40 * 60000, NOW), '40 мин назад');
  assert.strictEqual(humanLeft(NOW + 2 * 86400000, NOW), 'через 2 дн');
});

console.log('Просрочка (решение владельца: запас 12 часов):');

t('время ещё не пришло — ждём', () => {
  assert.strictEqual(decideOverdue({ fireAt: NOW + 60000 }, NOW, 12), 'wait');
});

t('опоздание 3 часа — отправляем', () => {
  assert.strictEqual(decideOverdue({ fireAt: NOW - 3 * 3600000 }, NOW, 12), 'send');
});

t('опоздание ровно 12 часов — ещё отправляем', () => {
  assert.strictEqual(decideOverdue({ fireAt: NOW - 12 * 3600000 }, NOW, 12), 'send');
});

t('опоздание 13 часов — просрочено, не отправляем', () => {
  assert.strictEqual(decideOverdue({ fireAt: NOW - 13 * 3600000 }, NOW, 12), 'miss');
});

t('shortText не рвёт короткое и обрезает длинное', () => {
  assert.strictEqual(shortText('коротко', 70), 'коротко');
  assert.strictEqual(shortText('a'.repeat(100), 10).length, 10);
});

console.log('Колесо времени (как в часах на айфоне):');

const { wheelClockAt, wheelAfterAt, wheelIndexFromScroll, range, normalizeTarget, targetLabel } = internals;

t('выбрал 14:50, сейчас 14:30 — уйдёт сегодня в 14:50', () => {
  const d = new Date(wheelClockAt(14, 50, NOW).at);
  assert.strictEqual(d.getDate(), 24);
  assert.strictEqual(d.getHours(), 14);
  assert.strictEqual(d.getMinutes(), 50);
});

t('выбрал 9:00, сейчас 14:30 — уйдёт ЗАВТРА в 9:00, а не в прошлое', () => {
  const d = new Date(wheelClockAt(9, 0, NOW).at);
  assert.strictEqual(d.getDate(), 25);
  assert.strictEqual(d.getHours(), 9);
});

t('выбрал 00:00 — это полночь следующего дня', () => {
  const d = new Date(wheelClockAt(0, 0, NOW).at);
  assert.strictEqual(d.getDate(), 25);
  assert.strictEqual(d.getHours(), 0);
});

t('«через сколько»: 0 ч 50 мин — ровно пятьдесят минут', () => {
  assert.strictEqual(wheelAfterAt(0, 50, NOW).at, NOW + 50 * 60000);
});

t('«через сколько»: 2 ч 5 мин', () => {
  assert.strictEqual(wheelAfterAt(2, 5, NOW).at, NOW + 125 * 60000);
});

t('«через сколько»: 0 ч 0 мин — ошибка, а не отправка сию секунду', () => {
  assert.ok(wheelAfterAt(0, 0, NOW).error);
});

t('деление колеса считается по прокрутке', () => {
  assert.strictEqual(wheelIndexFromScroll(0, 34, 24), 0);
  assert.strictEqual(wheelIndexFromScroll(34 * 3, 34, 24), 3);
  assert.strictEqual(wheelIndexFromScroll(34 * 3 + 10, 34, 24), 3, 'ближе к третьему');
  assert.strictEqual(wheelIndexFromScroll(34 * 3 + 25, 34, 24), 4, 'ближе к четвёртому');
  assert.strictEqual(wheelIndexFromScroll(-50, 34, 24), 0, 'за край не уходим');
  assert.strictEqual(wheelIndexFromScroll(99999, 34, 24), 23, 'и за другой край тоже');
  assert.strictEqual(wheelIndexFromScroll('мусор', 34, 24), 0);
});

t('колёса показывают правильные наборы', () => {
  assert.strictEqual(range(24).length, 24);
  assert.strictEqual(range(60)[59], 59);
});

console.log('Куда класть сообщение:');

t('выбор чата сохраняется, мусор превращается в «открытую вкладку»', () => {
  assert.deepStrictEqual(
    normalizeTarget({ title: 'BIORISE', win: 1, index: 2 }),
    { title: 'BIORISE', win: 1, index: 2 });
  assert.strictEqual(normalizeTarget('new'), 'new');
  assert.strictEqual(normalizeTarget(undefined), 'current');
  assert.strictEqual(normalizeTarget({ nothing: 1 }), 'current');
});

t('подпись выбора понятна человеку', () => {
  assert.strictEqual(targetLabel({ title: 'BIORISE', win: 0, index: 0 }), 'в чат «BIORISE»');
  assert.strictEqual(targetLabel('new'), 'в новую вкладку');
  assert.strictEqual(targetLabel('current'), 'в открытую вкладку');
});

console.log(`\nВсего зелёных: ${passed}`);
if (process.exitCode) { console.error('ЕСТЬ ПАДЕНИЯ'); } else { console.log('Все проверки прошли'); }
