/*
 * Загрузка настоящего main.js вне Обсидиана.
 *
 * Плагин требует модуль 'obsidian', которого в обычном node нет. Подменяем ТОЛЬКО его —
 * сам код плагина берём настоящий, не копию и не пересказ (§🧫 v3.34: тест, подменяющий
 * проверяемое звено, ничего не доказывает).
 */

'use strict';

const Module = require('module');
const path = require('path');

class Fake {
  constructor() {}
}
const fakeObsidian = {
  Plugin: class extends Fake {},
  PluginSettingTab: class extends Fake {},
  Setting: class extends Fake {},
  Modal: class extends Fake {},
  Notice: class extends Fake {},
  setIcon: () => {},
  requestUrl: async () => ({ status: 200 }),
  Platform: { isMacOS: true },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return fakeObsidian;
  return origLoad.apply(this, arguments);
};

const plugin = require(path.join(__dirname, '..', 'main.js'));

module.exports = { internals: plugin._internals, fakeObsidian };
