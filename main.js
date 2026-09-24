'use strict';

/*
 * Claudian Schedule — отложенные сообщения Клодиану.
 *
 * Что делает: ты пишешь сообщение сейчас и указываешь время. В назначенный час
 * плагин сам кладёт его в чат Клодиана и отправляет — как будто ты набрал и нажал Enter.
 *
 * Стык с Клодианом — через интерфейс (те же опорные точки, что у Claudian Voice):
 *   - поле ввода:  textarea.claudian-input  внутри .workspace-leaf-content[data-type="claudian-view"]
 *   - переписка:   .claudian-messages → .claudian-message-user
 *   - агент занят: .claudian-tab-badge-streaming
 *   - команды:     realclaudian:open-view, realclaudian:new-tab
 *
 * Честное ограничение: плагин живёт внутри Обсидиана. Обсидиан закрыт — никто ничего
 * не отправит. Мак спал — при пробуждении сработает проверка просрочки (запас 12 часов).
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal, setIcon, Platform } = require('obsidian');

// ────────────────────────────────────────────────────────────────────────────
// Настройки по умолчанию
// ────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  graceHours: 12,        // опоздание меньше этого — всё равно отправляем при запуске
  checkSec: 20,          // как часто смотреть на часы
  busyWaitMin: 10,       // сколько ждать, пока агент допишет ответ
  defaultTarget: 'current', // 'current' — в открытую вкладку, 'new' — в новую
  notify: true,          // показывать всплывающие уведомления об отправке
  keepDays: 14,          // сколько дней держать историю отправленных
  writeLog: true,        // вести schedule.log рядом с плагином
};

const PLUGIN_ID = 'claudian-schedule';

// ────────────────────────────────────────────────────────────────────────────
// Чистые функции: время. Ничего не знают про Обсидиан — проверяются тестами.
// ────────────────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

/**
 * Разбор написанного человеком времени.
 * Возвращает { at: миллисекунды } или { error: 'причина по-русски' }.
 *
 * Молчаливого «ноля» быть не должно: непонятный ввод — это ошибка с причиной,
 * а не «отправлю прямо сейчас» (§🤐 v3.35).
 */
function parseWhen(raw, now = Date.now()) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return { error: 'не указано время' };

  // ── «через 30 минут», «через 2 часа», «через 1,5 часа», «через 3 дня» ──
  const rel = s.match(/^через\s+(\d+(?:[.,]\d+)?)\s*([а-яё]*)\.?$/);
  if (rel) {
    const n = parseFloat(rel[1].replace(',', '.'));
    const unit = rel[2] || 'мин';
    let mult = null;
    if (/^мин|^м$/.test(unit)) mult = 60000;
    else if (/^час|^ч$/.test(unit)) mult = 3600000;
    else if (/^дн|^день|^д$/.test(unit)) mult = 86400000;
    else if (/^сек|^с$/.test(unit)) mult = 1000;
    if (!mult) return { error: 'не понял единицу: пиши «минут», «часов» или «дней»' };
    if (!(n > 0)) return { error: 'сколько именно? число должно быть больше нуля' };
    return { at: Math.round(now + n * mult) };
  }

  // ── день словом: «сегодня 18:00», «завтра в 9», «послезавтра 7:30» ──
  let dayShift = null;
  let rest = s;
  // Без \b: в обычной регулярке JS русские буквы не считаются «словесными»,
  // и граница слова после «сегодня» не находится вовсе.
  const dayWord = s.match(/^(сегодня|завтра|послезавтра)(?:\s+(?:в\s+)?(.*))?$/);
  if (dayWord) {
    dayShift = { 'сегодня': 0, 'завтра': 1, 'послезавтра': 2 }[dayWord[1]];
    rest = (dayWord[2] || '').trim();
    if (!rest) return { error: 'во сколько? допиши время, например «завтра 9:00»' };
  }

  // ── дата: «24.09 18:30», «24.09.2026 18:30», «2026-09-24 18:30» ──
  if (dayShift === null) {
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2})(?:[:.](\d{2}))?)?$/);
    if (iso) {
      const d = new Date(+iso[1], +iso[2] - 1, +iso[3], iso[4] ? +iso[4] : 9, iso[5] ? +iso[5] : 0, 0, 0);
      return finishDate(d, now);
    }
    const ru = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?:\s*(?:в\s*)?(\d{1,2})(?:[:.](\d{2}))?)?$/);
    if (ru) {
      const nowD = new Date(now);
      let year = ru[3] ? +ru[3] : nowD.getFullYear();
      if (year < 100) year += 2000;
      const d = new Date(year, +ru[2] - 1, +ru[1], ru[4] ? +ru[4] : 9, ru[5] ? +ru[5] : 0, 0, 0);
      if (!ru[3] && d.getTime() < now) d.setFullYear(year + 1); // «31.12» в январе — это конец года, а не прошлый
      return finishDate(d, now);
    }
  }

  // ── только время: «18:00», «18.30», «9» ──
  const t = rest.match(/^(\d{1,2})(?:[:.\-](\d{2}))?$/);
  if (t) {
    const hh = +t[1];
    const mm = t[2] ? +t[2] : 0;
    if (hh > 23 || mm > 59) return { error: 'такого времени не бывает: часы 0-23, минуты 0-59' };
    const base = new Date(now);
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (dayShift || 0), hh, mm, 0, 0);
    // «18:00», когда уже 19:00 и день не назван словом → значит завтра, а не в прошлое
    if (dayShift === null && d.getTime() <= now) d.setDate(d.getDate() + 1);
    return finishDate(d, now);
  }

  return { error: 'не понял время. Примеры: «через 30 минут», «сегодня 18:00», «завтра 9:00», «24.09 18:30»' };
}

function finishDate(d, now) {
  const at = d.getTime();
  if (!isFinite(at)) return { error: 'не понял дату' };
  if (at <= now) return { error: 'это время уже прошло' };
  return { at };
}

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** «сегодня в 18:00» / «завтра в 09:00» / «26.09 в 18:30» */
function formatWhen(at, now = Date.now()) {
  const d = new Date(at);
  const n = new Date(now);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, n)) return `сегодня в ${hhmm}`;
  if (sameDay(d, new Date(now + 86400000))) return `завтра в ${hhmm}`;
  if (sameDay(d, new Date(now - 86400000))) return `вчера в ${hhmm}`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} в ${hhmm}`;
}

/** «через 5 мин» / «через 2 ч 10 мин» / «40 мин назад» */
function humanLeft(at, now = Date.now()) {
  const diff = at - now;
  const past = diff < 0;
  const min = Math.round(Math.abs(diff) / 60000);
  let s;
  if (min < 1) s = 'меньше минуты';
  else if (min < 60) s = `${min} мин`;
  else if (min < 1440) {
    const h = Math.floor(min / 60), m = min % 60;
    s = m ? `${h} ч ${m} мин` : `${h} ч`;
  } else {
    const dd = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60);
    s = h ? `${dd} дн ${h} ч` : `${dd} дн`;
  }
  return past ? `${s} назад` : `через ${s}`;
}

/**
 * Что делать с сообщением, время которого уже прошло (мы были выключены).
 * Решение владельца 24.09.2026: опоздание меньше запаса — отправляем, больше — «просрочено».
 */
function decideOverdue(item, now, graceHours) {
  const lateMs = now - item.fireAt;
  if (lateMs < 0) return 'wait';
  if (lateMs <= graceHours * 3600000) return 'send';
  return 'miss';
}

/** Короткая выжимка текста для списков и уведомлений. */
function shortText(text, limit = 70) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > limit ? one.slice(0, limit - 1) + '…' : one;
}

// ────────────────────────────────────────────────────────────────────────────
// Работа с окном Клодиана. Функции берут документ извне — их можно проверить
// на настоящем дереве страницы (jsdom), а не на самодельной заглушке (§🧫 v3.34).
// ────────────────────────────────────────────────────────────────────────────

const SEL = {
  leaf: '.workspace-leaf-content[data-type="claudian-view"]',
  input: 'textarea.claudian-input',
  messages: '.claudian-messages',
  userMsg: '.claudian-message-user',
  streaming: '.claudian-tab-badge-streaming',
  toolbar: '.claudian-input-toolbar',
};

/** Есть ли в документе раскладка (в тестовой среде её нет — там размеры всегда нулевые). */
function hasLayout(doc) {
  const b = doc && doc.body;
  return !!(b && b.getClientRects && b.getClientRects().length);
}

function isVisible(el) {
  if (!el) return false;
  if (hasLayout(el.ownerDocument)) return !!(el.getClientRects && el.getClientRects().length);
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const st = (n.getAttribute && n.getAttribute('style')) || '';
    if (/display\s*:\s*none/.test(st) || /visibility\s*:\s*hidden/.test(st)) return false;
    if (n.hasAttribute && n.hasAttribute('hidden')) return false;
  }
  return true;
}

/** Видимое поле ввода Клодиана (или null, если окна нет). */
function findInput(doc) {
  const list = doc.querySelectorAll(`${SEL.leaf} ${SEL.input}`);
  for (const el of list) if (isVisible(el)) return el;
  return null;
}

/**
 * Пустое видимое поле ввода — им пользуемся после открытия новой вкладки.
 * Клодиан может и переключить вкладку внутри того же окна (элемент тот же, но пустой),
 * и открыть новую панель (элемент другой). Оба случая закрываются поиском пустого поля.
 */
function findEmptyInput(doc) {
  const list = doc.querySelectorAll(`${SEL.leaf} ${SEL.input}`);
  for (const el of list) if (isVisible(el) && !(el.value || '').trim()) return el;
  return null;
}

/** Агент сейчас печатает ответ? */
function isStreaming(doc, input) {
  const scope = (input && input.closest && input.closest('.workspace-leaf-content')) || doc;
  return !!scope.querySelector(SEL.streaming);
}

/** Сколько сообщений от пользователя в этой вкладке — по ним проверяем, что отправка состоялась. */
function countUserMessages(doc, input) {
  const scope = (input && input.closest && input.closest('.workspace-leaf-content')) || doc;
  return scope.querySelectorAll(SEL.userMsg).length;
}

/** Нажатие Enter так, как его ждёт Клодиан (с Cmd/Ctrl, если так настроено). */
function pressEnter(input, withMod, isMac) {
  const win = (input.ownerDocument && input.ownerDocument.defaultView) || globalThis;
  input.dispatchEvent(new win.KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
    metaKey: !!withMod && !!isMac, ctrlKey: !!withMod && !isMac,
  }));
}

/**
 * Доставка сообщения в чат.
 *
 * env = {
 *   doc,                       документ страницы
 *   run(commandId),            выполнить команду Обсидиана
 *   sleep(ms),                 подождать
 *   requireMod,                у Клодиана отправка на Cmd/Ctrl+Enter
 *   isMac,
 *   verifyTimeoutMs            сколько ждать подтверждения отправки
 * }
 *
 * Возвращает { ok, via, reason }. ok=false при retry=true означает «занят, попробуй позже».
 */
async function deliverText(env, text, target) {
  const { doc, run, sleep } = env;
  const verifyTimeoutMs = env.verifyTimeoutMs == null ? 6000 : env.verifyTimeoutMs;

  let input = findInput(doc);

  // 1. Окно Клодиана закрыто — открываем сами
  if (!input) {
    await run('realclaudian:open-view');
    await sleep(800);
    input = findInput(doc);
    if (!input) return { ok: false, reason: 'окно Клодиана не открылось' };
  }

  // 2. Агент печатает — не встреваем, вернёмся позже
  if (isStreaming(doc, input)) return { ok: false, retry: true, reason: 'агент печатает ответ' };

  // 3. Куда класть. В поле есть черновик — не трогаем его, уходим в новую вкладку.
  let via = target === 'new' ? 'new' : 'current';
  const draft = (input.value || '').trim();
  if (draft) via = 'new';

  if (via === 'new') {
    await run('realclaudian:new-tab');
    await sleep(800);
    const fresh = findEmptyInput(doc);
    // Пустого поля нет — значит вкладка не открылась (или там тоже черновик).
    // Это временная помеха, а не отказ: вернёмся на следующем тике.
    if (!fresh) return { ok: false, retry: true, reason: 'новая вкладка не открылась' };
    input = fresh;
  }

  // 4. Вставляем и отправляем
  const before = countUserMessages(doc, input);
  const win = (doc.defaultView || globalThis);
  input.value = text;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  if (input.focus) input.focus();
  pressEnter(input, env.requireMod, env.isMac);

  // 5. Проверяем ИСХОД, а не попытку: поле опустело и в переписке прибавилось
  //    сообщение от пользователя (§🎯 v2.85, §👁 v3.16).
  const step = 200;
  let waited = 0;
  let triedMod = !!env.requireMod;
  while (waited < verifyTimeoutMs) {
    const emptied = !(input.value || '').trim();
    const grew = countUserMessages(doc, input) > before;
    if (emptied && grew) return { ok: true, via };
    // страховка: часть сборок Клодиана ждёт Cmd/Ctrl+Enter
    if (!triedMod && waited >= 400) { pressEnter(input, true, env.isMac); triedMod = true; }
    await sleep(step);
    waited += step;
  }

  // Не ушло — возвращаем поле как было, чтобы не оставлять мусор
  if ((input.value || '') === text) {
    input.value = '';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
  }
  return { ok: false, reason: 'Клодиан не принял сообщение (в переписке оно не появилось)' };
}

// ────────────────────────────────────────────────────────────────────────────
// Плагин
// ────────────────────────────────────────────────────────────────────────────

class ClaudianSchedulePlugin extends Plugin {
  async onload() {
    await this.loadState();

    this.busySince = new Map();   // id → когда впервые увидели «агент занят»
    this.working = false;         // чтобы тик не наступал сам себе на пятки
    this.buttons = new Set();

    this.addCommand({
      id: 'new',
      name: 'Отложить сообщение Клодиану',
      callback: () => this.openComposer(''),
    });
    this.addCommand({
      id: 'list',
      name: 'Отложенные сообщения — список',
      callback: () => new ListModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'from-input',
      name: 'Отложить то, что набрано в поле Клодиана',
      callback: () => this.composeFromInput(),
    });

    this.status = this.addStatusBarItem();
    this.status.addClass('cs-status');
    this.status.onclick = () => new ListModal(this.app, this).open();
    this.renderStatus();

    this.addSettingTab(new ScheduleSettingsTab(this.app, this));

    // Тик по часам + подсадка кнопки в панель Клодиана
    this.registerInterval(window.setInterval(() => this.tick(), Math.max(5, this.settings.checkSec) * 1000));
    this.registerInterval(window.setInterval(() => this.mountButtons(), 2000));

    // Проверка просрочки — когда интерфейс уже собран, иначе окна Клодиана ещё нет
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.startupCheck(), 3000);
      this.mountButtons();
    });
  }

  onunload() {
    this.buttons.forEach(b => b.remove());
    this.buttons.clear();
  }

  // ── Состояние ────────────────────────────────────────────────────────────

  async loadState() {
    const raw = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, raw.settings || {});
    this.items = Array.isArray(raw.items) ? raw.items : [];
  }

  async save() {
    await this.saveData({ settings: this.settings, items: this.items });
    this.renderStatus();
  }

  pending() {
    return this.items.filter(i => i.status === 'pending' || i.status === 'sending')
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  history() {
    return this.items.filter(i => i.status !== 'pending' && i.status !== 'sending')
      .sort((a, b) => (b.sentAt || b.fireAt) - (a.sentAt || a.fireAt));
  }

  async addItem(text, fireAt, target) {
    const item = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      text: String(text),
      fireAt,
      target: target === 'new' ? 'new' : 'current',
      createdAt: Date.now(),
      status: 'pending',
      attempts: 0,
    };
    this.items.push(item);
    await this.save();
    this.log(`запланировано | ${formatWhen(fireAt)} | «${shortText(text, 50)}»`);
    return item;
  }

  async removeItem(id) {
    this.items = this.items.filter(i => i.id !== id);
    await this.save();
  }

  /** Подчистка старой истории, чтобы файл не рос вечно. */
  async prune() {
    const edge = Date.now() - this.settings.keepDays * 86400000;
    const before = this.items.length;
    this.items = this.items.filter(i =>
      i.status === 'pending' || i.status === 'sending' || (i.sentAt || i.fireAt) > edge);
    if (this.items.length !== before) await this.save();
  }

  // ── Часы ─────────────────────────────────────────────────────────────────

  /** Проверка при запуске: что мы проспали, пока Обсидиан был закрыт. */
  async startupCheck() {
    const now = Date.now();
    const missed = [];
    for (const item of this.items) {
      if (item.status !== 'pending' && item.status !== 'sending') continue;
      if (item.status === 'sending') item.status = 'pending'; // обрыв прошлого сеанса
      const what = decideOverdue(item, now, this.settings.graceHours);
      if (what === 'miss') {
        item.status = 'missed';
        item.note = `Обсидиан был закрыт, опоздание ${humanLeft(item.fireAt, now)}`;
        missed.push(item);
        this.log(`просрочено | ${formatWhen(item.fireAt, now)} | «${shortText(item.text, 50)}»`);
      }
    }
    if (missed.length) {
      await this.save();
      new Notice(
        `Отложенные сообщения: ${missed.length} не ушло — опоздание больше ${this.settings.graceHours} ч. ` +
        `Открой список, чтобы отправить или удалить.`, 10000);
    }
    await this.prune();
    await this.tick();   // ждём именно отправку: иначе «проверил просрочку» ≠ «сообщение ушло»
  }

  async tick() {
    if (this.working) return;
    const now = Date.now();
    const due = this.pending().filter(i => i.fireAt <= now);
    if (!due.length) { this.renderStatus(); return; }

    this.working = true;
    try {
      for (const item of due) await this.fire(item, now);
    } finally {
      this.working = false;
      this.renderStatus();
    }
  }

  /** Отправка одного сообщения. */
  async fire(item, now = Date.now()) {
    item.status = 'sending';
    item.attempts = (item.attempts || 0) + 1;
    await this.save();

    // Ждать ли, если агент занят: копим время ожидания по каждому сообщению
    const waitedFrom = this.busySince.get(item.id) || now;
    const waitedMin = (now - waitedFrom) / 60000;
    const forceNewTab = waitedMin >= this.settings.busyWaitMin;

    // Любая неожиданная поломка не должна оставить сообщение навсегда в «отправляется»
    let res;
    try {
      res = await deliverText(this.env(), item.text, forceNewTab ? 'new' : item.target);
    } catch (e) {
      res = { ok: false, reason: `сбой при отправке: ${e && e.message ? e.message : e}` };
      console.error('[claudian-schedule] сбой доставки:', e);
    }

    if (res.ok) {
      this.busySince.delete(item.id);
      item.status = 'sent';
      item.sentAt = Date.now();
      item.note = res.via === 'new' ? 'ушло в новую вкладку' : 'ушло в открытую вкладку';
      await this.save();
      this.log(`отправлено | ${item.note} | «${shortText(item.text, 50)}»`);
      if (this.settings.notify) new Notice(`Клодиану отправлено: «${shortText(item.text, 60)}»`, 6000);
      return;
    }

    if (res.retry) {
      if (!this.busySince.has(item.id)) this.busySince.set(item.id, now);
      item.status = 'pending';       // вернёмся на следующем тике
      item.note = res.reason;
      await this.save();
      this.log(`ждём | ${res.reason} | «${shortText(item.text, 50)}»`);
      return;
    }

    item.status = 'failed';
    item.note = res.reason || 'не удалось отправить';
    item.sentAt = Date.now();
    await this.save();
    this.log(`НЕ УДАЛОСЬ | ${item.note} | «${shortText(item.text, 50)}»`);
    new Notice(`Отложенное сообщение не ушло: ${item.note}`, 12000);
  }

  /** Отправить прямо сейчас (кнопка в списке). */
  async fireNow(item) {
    this.busySince.set(item.id, 0); // не ждать занятости — сразу в новую вкладку, если занят
    await this.fire(item);
  }

  env() {
    let requireMod = false;
    try {
      const rc = this.app.plugins.plugins['realclaudian'];
      requireMod = !!(rc && rc.settings && rc.settings.requireCommandOrControlEnterToSend);
    } catch (e) { /* настройка недоступна — шлём обычный Enter, дальше сработает страховка */ }
    return {
      doc: document,
      run: (id) => this.app.commands.executeCommandById(id),
      sleep: (ms) => new Promise(r => window.setTimeout(r, ms)),
      requireMod,
      isMac: typeof Platform !== 'undefined' ? !!Platform.isMacOS : true,
    };
  }

  // ── Лицо ─────────────────────────────────────────────────────────────────

  renderStatus() {
    if (!this.status) return;
    const list = this.pending();
    if (!list.length) { this.status.setText(''); this.status.title = ''; return; }
    const next = list[0];
    this.status.setText(`⏰ ${list.length}`);
    this.status.title = `Ближайшее: ${formatWhen(next.fireAt)} (${humanLeft(next.fireAt)})\n«${shortText(next.text, 60)}»`;
  }

  /** Кнопка ⏰ в панели ввода Клодиана — отложить то, что уже набрано. */
  mountButtons() {
    const toolbars = document.querySelectorAll(SEL.toolbar);
    toolbars.forEach(tb => {
      if (tb.querySelector('.cs-clock-btn')) return;
      const btn = tb.createEl('button', { cls: 'cs-clock-btn clickable-icon' });
      btn.setAttribute('aria-label', 'Отложить сообщение на время');
      btn.title = 'Отложить сообщение на время';
      // setIcon при неизвестном имени значка молча ничего не рисует — проверяем результат,
      // а не сам вызов, иначе кнопка окажется пустой (§🚥 v3.59).
      try { setIcon(btn, 'alarm-clock'); } catch (e) { /* ниже поставим запасной значок */ }
      if (!btn.childElementCount) btn.setText('⏰');
      btn.onclick = (e) => { e.preventDefault(); this.composeFromInput(); };
      this.buttons.add(btn);
    });
  }

  composeFromInput() {
    const input = findInput(document);
    const text = input ? input.value : '';
    this.openComposer(text, () => {
      if (!input) return;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  openComposer(text, onScheduled) {
    new ComposeModal(this.app, this, { text: text || '', onScheduled }).open();
  }

  // ── Журнал ───────────────────────────────────────────────────────────────

  /** Строчка в schedule.log рядом с плагином: разбирать «почему не ушло» по факту. */
  log(line) {
    if (!this.settings.writeLog) return;
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(this.app.vault.adapter.getBasePath(), '.obsidian', 'plugins', PLUGIN_ID);
      const d = new Date();
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      fs.appendFileSync(path.join(dir, 'schedule.log'), `${stamp} | ${line}\n`, 'utf8');
    } catch (e) {
      console.warn('[claudian-schedule] журнал не пишется:', e);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Окно «отложить сообщение»
// ────────────────────────────────────────────────────────────────────────────

class ComposeModal extends Modal {
  /**
   * opts: { text, item, onScheduled, onDone }
   * item задан — окно работает как «перенести»: меняем время у существующего сообщения.
   */
  constructor(app, plugin, opts = {}) {
    super(app);
    this.plugin = plugin;
    this.item = opts.item || null;
    this.text = this.item ? this.item.text : (opts.text || '');
    this.whenRaw = 'через 1 час';
    this.target = this.item ? this.item.target : plugin.settings.defaultTarget;
    this.onScheduled = opts.onScheduled;
    this.onDone = opts.onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('cs-modal');
    contentEl.createEl('h3', { text: this.item ? 'Перенести сообщение' : 'Отложить сообщение Клодиану' });

    // Текст
    contentEl.createEl('label', { text: 'Сообщение', cls: 'cs-label' });
    const ta = contentEl.createEl('textarea', { cls: 'cs-text' });
    ta.value = this.text;
    ta.placeholder = 'Что Клодиан должен получить в назначенное время…';
    ta.rows = 6;
    ta.oninput = () => { this.text = ta.value; this.refresh(); };

    // Быстрые кнопки
    contentEl.createEl('label', { text: 'Когда', cls: 'cs-label' });
    const quick = contentEl.createDiv({ cls: 'cs-quick' });
    const presets = [
      ['через 15 минут', 'через 15 минут'],
      ['через 30 минут', 'через 30 минут'],
      ['через 1 час', 'через 1 час'],
      ['через 3 часа', 'через 3 часа'],
      ['сегодня 18:00', 'сегодня 18:00'],
      ['завтра 9:00', 'завтра 9:00'],
    ];
    presets.forEach(([label, value]) => {
      const b = quick.createEl('button', { text: label, cls: 'cs-chip' });
      b.onclick = () => { this.whenRaw = value; whenInput.value = value; this.refresh(); };
    });

    const whenInput = contentEl.createEl('input', { cls: 'cs-when', type: 'text' });
    whenInput.value = this.whenRaw;
    whenInput.placeholder = 'через 30 минут / сегодня 18:00 / завтра 9:00 / 24.09 18:30';
    whenInput.oninput = () => { this.whenRaw = whenInput.value; this.refresh(); };

    this.preview = contentEl.createDiv({ cls: 'cs-preview' });

    // Куда
    const targetWrap = contentEl.createDiv({ cls: 'cs-target' });
    targetWrap.createEl('span', { text: 'Куда положить: ' });
    const sel = targetWrap.createEl('select');
    sel.createEl('option', { text: 'в открытую вкладку', value: 'current' });
    sel.createEl('option', { text: 'в новую вкладку', value: 'new' });
    sel.value = this.target;
    sel.onchange = () => { this.target = sel.value; };
    targetWrap.createEl('div', {
      cls: 'cs-hint',
      text: 'Если в поле ввода будет черновик или агент будет занят — сообщение само уйдёт в новую вкладку, набранное не пропадёт.',
    });

    // Кнопки
    const row = contentEl.createDiv({ cls: 'cs-row' });
    this.okBtn = row.createEl('button', { text: this.item ? 'Перенести' : 'Запланировать', cls: 'mod-cta' });
    this.okBtn.onclick = () => this.submit();
    const cancel = row.createEl('button', { text: 'Отмена' });
    cancel.onclick = () => this.close();

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.submit(); }
    });
    whenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
    });

    this.refresh();
    window.setTimeout(() => ta.focus(), 30);
  }

  refresh() {
    const res = parseWhen(this.whenRaw);
    const okText = !!String(this.text).trim();
    if (res.error) {
      this.preview.setText(`⚠️ ${res.error}`);
      this.preview.removeClass('cs-ok');
    } else {
      this.preview.setText(`Уйдёт ${formatWhen(res.at)} — это ${humanLeft(res.at)}`);
      this.preview.addClass('cs-ok');
    }
    if (this.okBtn) this.okBtn.disabled = !!res.error || !okText;
  }

  async submit() {
    const text = String(this.text).trim();
    if (!text) { new Notice('Сначала напиши сообщение'); return; }
    const res = parseWhen(this.whenRaw);
    if (res.error) { new Notice(`Время: ${res.error}`); return; }

    if (this.item) {
      this.item.text = text;
      this.item.fireAt = res.at;
      this.item.target = this.target;
      this.item.status = 'pending';
      this.item.note = '';
      await this.plugin.save();
      new Notice(`Перенесено: уйдёт ${formatWhen(res.at)} (${humanLeft(res.at)})`, 6000);
    } else {
      await this.plugin.addItem(text, res.at, this.target);
      new Notice(`Отложено: уйдёт ${formatWhen(res.at)} (${humanLeft(res.at)})`, 6000);
    }
    if (this.onScheduled) { try { this.onScheduled(); } catch (e) {} }
    this.close();
    if (this.onDone) { try { this.onDone(); } catch (e) {} }
  }

  onClose() { this.contentEl.empty(); }
}

// ────────────────────────────────────────────────────────────────────────────
// Окно «список отложенных»
// ────────────────────────────────────────────────────────────────────────────

const STATUS_RU = {
  pending: 'ждёт',
  sending: 'отправляется',
  sent: 'отправлено',
  missed: 'просрочено',
  failed: 'не удалось',
};

class ListModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }

  onOpen() {
    this.contentEl.addClass('cs-modal');
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Отложенные сообщения' });

    const add = contentEl.createEl('button', { text: '+ Новое отложенное сообщение', cls: 'mod-cta cs-add' });
    add.onclick = () => { this.close(); this.plugin.openComposer(''); };

    const pending = this.plugin.pending();
    contentEl.createEl('h4', { text: `В очереди: ${pending.length}` });
    if (!pending.length) {
      contentEl.createDiv({ cls: 'cs-hint', text: 'Пока пусто. Напиши сообщение и укажи время — оно уйдёт само.' });
    }
    pending.forEach(item => this.row(contentEl, item, true));

    const history = this.plugin.history().slice(0, 12);
    if (history.length) {
      contentEl.createEl('h4', { text: 'История' });
      history.forEach(item => this.row(contentEl, item, false));
    }
  }

  row(parent, item, isPending) {
    const el = parent.createDiv({ cls: 'cs-item' });
    const head = el.createDiv({ cls: 'cs-item-head' });
    head.createEl('span', {
      cls: `cs-badge cs-${item.status}`,
      text: STATUS_RU[item.status] || item.status,
    });
    head.createEl('span', {
      cls: 'cs-time',
      text: isPending
        ? `${formatWhen(item.fireAt)} · ${humanLeft(item.fireAt)}`
        : `${formatWhen(item.sentAt || item.fireAt)}`,
    });
    if (item.target === 'new') head.createEl('span', { cls: 'cs-hint', text: ' · в новую вкладку' });
    el.createDiv({ cls: 'cs-item-text', text: shortText(item.text, 200) });
    if (item.note) el.createDiv({ cls: 'cs-hint', text: item.note });

    const row = el.createDiv({ cls: 'cs-row' });
    if (isPending || item.status === 'missed' || item.status === 'failed') {
      const now = row.createEl('button', { text: 'Отправить сейчас' });
      now.onclick = async () => {
        now.disabled = true;
        item.status = 'pending';
        await this.plugin.fireNow(item);
        this.render();
      };
      const move = row.createEl('button', { text: 'Перенести' });
      move.onclick = () => {
        // window.prompt в Обсидиане (Electron) не работает — только своё окно
        new ComposeModal(this.app, this.plugin, { item, onDone: () => this.render() }).open();
      };
    }
    const del = row.createEl('button', { text: 'Удалить', cls: 'mod-warning' });
    del.onclick = async () => { await this.plugin.removeItem(item.id); this.render(); };
  }

  onClose() { this.contentEl.empty(); }
}

// ────────────────────────────────────────────────────────────────────────────
// Настройки
// ────────────────────────────────────────────────────────────────────────────

class ScheduleSettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.save();

    containerEl.createEl('h3', { text: 'Отложенные сообщения Клодиану' });
    containerEl.createEl('p', {
      cls: 'cs-hint',
      text: 'Плагин работает, только пока открыт Обсидиан. Если он был закрыт, сообщение уйдёт при следующем запуске — в пределах запаса ниже.',
    });

    new Setting(containerEl)
      .setName('Запас на просрочку')
      .setDesc('Обсидиан был закрыт: опоздание меньше этого — всё равно отправляем. Больше — помечаем «просрочено» и показываем в списке.')
      .addSlider(sl => sl.setLimits(1, 48, 1).setValue(s.graceHours).setDynamicTooltip()
        .onChange(async v => { s.graceHours = v; await save(); }));

    new Setting(containerEl)
      .setName('Ждать занятого агента')
      .setDesc('Сколько минут ждать, если Клодиан в этот момент дописывает ответ. Дольше — сообщение уйдёт в новую вкладку.')
      .addSlider(sl => sl.setLimits(1, 60, 1).setValue(s.busyWaitMin).setDynamicTooltip()
        .onChange(async v => { s.busyWaitMin = v; await save(); }));

    new Setting(containerEl)
      .setName('Куда класть по умолчанию')
      .setDesc('В окне создания это можно менять для каждого сообщения.')
      .addDropdown(d => d
        .addOption('current', 'в открытую вкладку')
        .addOption('new', 'в новую вкладку')
        .setValue(s.defaultTarget)
        .onChange(async v => { s.defaultTarget = v; await save(); }));

    new Setting(containerEl)
      .setName('Как часто смотреть на часы')
      .setDesc('В секундах. Реже — меньше суеты, точность отправки падает на это же время.')
      .addSlider(sl => sl.setLimits(10, 120, 5).setValue(s.checkSec).setDynamicTooltip()
        .onChange(async v => { s.checkSec = v; await save(); }));

    new Setting(containerEl)
      .setName('Показывать уведомление при отправке')
      .addToggle(t => t.setValue(s.notify).onChange(async v => { s.notify = v; await save(); }));

    new Setting(containerEl)
      .setName('Хранить историю, дней')
      .addSlider(sl => sl.setLimits(1, 90, 1).setValue(s.keepDays).setDynamicTooltip()
        .onChange(async v => { s.keepDays = v; await save(); }));

    new Setting(containerEl)
      .setName('Вести журнал')
      .setDesc('Файл schedule.log рядом с плагином: что и когда ушло. Нужен, чтобы разбирать «почему не отправилось» по факту.')
      .addToggle(t => t.setValue(s.writeLog).onChange(async v => { s.writeLog = v; await save(); }));

    const help = containerEl.createDiv({ cls: 'cs-help' });
    help.createEl('h4', { text: 'Как пользоваться' });
    const ul = help.createEl('ul');
    ul.createEl('li', { text: '⏰ — кнопка в панели ввода Клодиана: набрал сообщение, нажал часы, выбрал время.' });
    ul.createEl('li', { text: 'Cmd+P → «Отложить сообщение Клодиану» — то же самое из любого места.' });
    ul.createEl('li', { text: 'Счётчик ⏰ внизу окна показывает, сколько сообщений ждёт. Клик — список.' });
    ul.createEl('li', { text: 'Время пишется по-человечески: «через 30 минут», «сегодня 18:00», «завтра 9:00», «24.09 18:30».' });
  }
}

module.exports = ClaudianSchedulePlugin;

// Внутренности — для тестов (в Обсидиане не используются)
module.exports._internals = {
  parseWhen, formatWhen, humanLeft, decideOverdue, shortText,
  findInput, findEmptyInput, isStreaming, countUserMessages, deliverText, SEL, DEFAULTS,
};
