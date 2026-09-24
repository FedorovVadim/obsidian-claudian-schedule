/*
 * Поддельный Клодиан для проверок — повторяет НАСТОЯЩЕЕ устройство сборки 2.2.6,
 * а не мои представления о нём. Каждое свойство сверено с кодом плагина 24.09.2026:
 *
 *   1. Вкладки лежат в ОДНОМ окне: .claudian-tab-content-container → .claudian-tab-content,
 *      неактивные скрыты классом .claudian-hidden (в коде: createDiv({cls:"claudian-tab-content claudian-hidden"})).
 *   2. Сообщения пользователя помечены атрибутом data-role="user".
 *   3. Занятый агент НЕ отклоняет сообщение, а ставит в очередь: .claudian-input-queue-row
 *      показывает «⌙ Queued: …», поле ввода очищается (в коде: queuedMessage = merge…, c.value="").
 *   4. Бейдж вкладки: активная получает -active, и только неактивная — -streaming.
 *      Поэтому по бейджу занятость активной вкладки НЕ определяется.
 *   5. При выключенной настройке requireCommandOrControlEnterToSend отправляют ОБА
 *      нажатия: и простой Enter, и Cmd/Ctrl+Enter (в коде: !0!==t.require… || Pht(e)).
 *   6. Отправка асинхронная: сообщение появляется в переписке не в тот же миг.
 */

'use strict';

const { JSDOM } = require('jsdom');

function makeClaudian(opts = {}) {
  const {
    open = true,            // окно Клодиана открыто
    requireMod = false,     // настройка «отправлять на Cmd/Ctrl+Enter»
    busy = false,           // агент сейчас пишет ответ → сообщения уходят в очередь
    sendDelay = 0,          // через сколько «снов» сообщение появится в переписке
    canOpen = true,         // команда открытия окна работает
    canNewTab = true,       // команда новой вкладки работает (у Клодиана есть предел вкладок)
    popout = false,         // второе окно Обсидиана (оторванное)
    deaf = false,           // Клодиан вообще не реагирует на Enter
  } = opts;

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const dom2 = popout ? new JSDOM('<!doctype html><html><body></body></html>') : null;
  const doc2 = dom2 ? dom2.window.document : null;

  const calls = [];
  const presses = [];
  let sleeps = 0;
  const pending = [];        // отложенная доставка: {atSleep, fn}

  function makeLeaf(targetDoc) {
    const leaf = targetDoc.createElement('div');
    leaf.className = 'workspace-leaf-content';
    leaf.setAttribute('data-type', 'claudian-view');
    const container = targetDoc.createElement('div');
    container.className = 'claudian-tab-content-container';
    leaf.appendChild(container);
    targetDoc.body.appendChild(leaf);
    return { leaf, container };
  }

  const leaves = [];
  if (open) leaves.push(makeLeaf(doc));
  if (popout) leaves.push(makeLeaf(doc2));

  /** Новая вкладка внутри окна: прежние прячутся классом, как в настоящем Клодиане. */
  function addTab(leafIndex = 0) {
    const holder = leaves[leafIndex];
    if (!holder) return null;
    holder.container.querySelectorAll('.claudian-tab-content')
      .forEach(t => t.classList.add('claudian-hidden'));

    const d = holder.container.ownerDocument;
    const tab = d.createElement('div');
    tab.className = 'claudian-tab-content';
    const messages = d.createElement('div');
    messages.className = 'claudian-messages';
    const queue = d.createElement('div');
    queue.className = 'claudian-input-queue-row';
    const toolbar = d.createElement('div');
    toolbar.className = 'claudian-input-toolbar';
    const ta = d.createElement('textarea');
    ta.className = 'claudian-input';
    tab.append(messages, queue, toolbar, ta);
    holder.container.appendChild(tab);

    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || deaf) return;
      // настоящее условие Клодиана: при выключенной настройке проходит любое нажатие
      const modOk = requireMod ? (e.metaKey || e.ctrlKey) : true;
      if (!modOk) return;
      const text = ta.value;
      if (!text.trim()) return;
      presses.push(text);
      const deliver = () => {
        ta.value = '';
        if (busy) {
          // занятый агент: сообщение уходит в очередь, в переписке пока не появляется
          queue.textContent = `⌙ Queued: ${text}`;
        } else {
          const msg = d.createElement('div');
          msg.className = 'claudian-message claudian-message-user';
          msg.setAttribute('data-role', 'user');
          msg.textContent = text;
          messages.appendChild(msg);
        }
      };
      if (sendDelay > 0) pending.push({ atSleep: sleeps + sendDelay, fn: deliver });
      else deliver();
    });
    return { tab, ta, messages, queue, toolbar };
  }

  const tabs = [];
  leaves.forEach((_, i) => tabs.push(addTab(i)));

  const env = {
    roots: () => leaves.map(l => l.leaf),
    run: async (suffix) => {
      calls.push(suffix);
      if (suffix === 'open-view') {
        if (!canOpen) return false;
        if (!leaves.length) { leaves.push(makeLeaf(doc)); tabs.push(addTab(0)); }
        return true;
      }
      if (suffix === 'new-tab') {
        if (!canNewTab) return false;      // Клодиан отказал: предел вкладок
        tabs.push(addTab(0));
        return true;
      }
      return false;
    },
    sleep: async () => {
      sleeps++;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].atSleep <= sleeps) { pending[i].fn(); pending.splice(i, 1); }
      }
    },
    requireMod: false,     // плагин по умолчанию не знает настройку
    modKnown: false,
    isMac: true,
    verifyTimeoutMs: 4000,
  };

  return {
    dom, doc, doc2, env, calls, tabs, leaves, addTab,
    presses,
    userTexts: () => [
      ...Array.from(doc.querySelectorAll('[data-role="user"]')).map(e => e.textContent),
      ...(doc2 ? Array.from(doc2.querySelectorAll('[data-role="user"]')).map(e => e.textContent) : []),
    ],
    queueTexts: () => Array.from(doc.querySelectorAll('.claudian-input-queue-row'))
      .map(e => e.textContent).filter(Boolean),
  };
}

module.exports = { makeClaudian };
