/*
 * Проверка «принял ли Клодиан сообщение на самом деле» — по его записям на диске.
 *
 * Это ответ на ошибку 25.09.2026: окно Обсидиана было в фоне, сообщение Клодиан принял
 * в 22:01:51, а на экране оно появилось позже — плагин отрапортовал «не ушло».
 *
 * Файлы здесь НАСТОЯЩИЕ (временная папка), формат записи взят из живого хранилища
 * Клодиана: { records: [ { timestamp, rawDisplayText, state } ] }.
 *
 * Запуск: node test/durable.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { internals } = require('./_load');
const { findDurableRecord } = internals;

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-durable-'));
const NOW = Date.now();
const SINCE = NOW - 5000;           // «отправили пять секунд назад»

const write = (name, records, mtimeMs) => {
  const full = path.join(dir, name);
  fs.writeFileSync(full, JSON.stringify({ schemaVersion: 1, records }), 'utf8');
  if (mtimeMs) fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
  return full;
};

// 1. Свежая запись с нашим текстом — то, что нужно найти
write('conv-свежая.inputs.json', [
  { timestamp: NOW - 100000, rawDisplayText: 'что-то давнее', state: 'accepted' },
  { timestamp: NOW - 1000, rawDisplayText: 'продолжи работу', state: 'accepted' },
]);

// 2. Файл переписан только что, но новых записей в нём нет — ловушка из живого хранилища:
//    25.09 один такой файл имел свежую отметку времени и записи суточной давности
write('conv-тронутая.inputs.json', [
  { timestamp: NOW - 86400000, rawDisplayText: 'продолжи работу', state: 'accepted' },
]);

// 3. Старый файл с подходящим текстом — не смотрим вовсе
write('conv-старая.inputs.json', [
  { timestamp: NOW - 1000, rawDisplayText: 'продолжи работу', state: 'accepted' },
], NOW - 3600000);

// 4. Испорченный файл — не должен ронять проверку
fs.writeFileSync(path.join(dir, 'conv-битая.inputs.json'), '{ это не json', 'utf8');

// 5. Посторонний файл рядом
fs.writeFileSync(path.join(dir, 'заметка.txt'), 'продолжи работу', 'utf8');

console.log('Поиск записи о принятом сообщении:');

t('свежая запись с нашим текстом — находится', () => {
  const r = findDurableRecord(fs, path, dir, 'продолжи работу', SINCE);
  assert.ok(r, 'запись должна найтись');
  assert.strictEqual(r.where, 'conv-свежая');
  assert.strictEqual(r.state, 'accepted');
});

t('файл переписан, но запись суточной давности — НЕ считается нашей', () => {
  // убираем свежий файл, остаётся только ловушка
  fs.unlinkSync(path.join(dir, 'conv-свежая.inputs.json'));
  const r = findDurableRecord(fs, path, dir, 'продолжи работу', SINCE);
  assert.strictEqual(r, null, 'старую запись за свою выдавать нельзя');
});

t('другой текст — не находится', () => {
  const r = findDurableRecord(fs, path, dir, 'совсем другое сообщение', SINCE);
  assert.strictEqual(r, null);
});

t('пустой текст — не находится (ничего не «совпадает со всем»)', () => {
  const r = findDurableRecord(fs, path, dir, '   ', SINCE);
  assert.strictEqual(r, null);
});

t('испорченный файл не роняет проверку', () => {
  // если бы ронял, предыдущие проверки уже упали бы с исключением
  assert.doesNotThrow(() => findDurableRecord(fs, path, dir, 'что угодно', SINCE));
});

t('папки нет вовсе — молча ничего, без падения', () => {
  const r = findDurableRecord(fs, path, path.join(dir, 'нет-такой-папки'), 'текст', SINCE);
  assert.strictEqual(r, null);
});

t('пробелы и переносы строк не мешают совпадению', () => {
  write('conv-многострочная.inputs.json', [
    { timestamp: NOW - 500, rawDisplayText: 'собери  сводку\nпо проектам', state: 'accepted' },
  ]);
  const r = findDurableRecord(fs, path, dir, 'собери сводку по проектам', SINCE);
  assert.ok(r, 'лишние пробелы не должны мешать');
});

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nВсего зелёных: ${passed}`);
if (process.exitCode) console.error('ЕСТЬ ПАДЕНИЯ'); else console.log('Все проверки прошли');
