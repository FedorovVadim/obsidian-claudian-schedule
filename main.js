'use strict';

/*
 * Claudian Schedule — отложенные сообщения Клодиану.
 *
 * Что делает: ты пишешь сообщение сейчас и указываешь время. В назначенный час
 * плагин сам кладёт его в чат Клодиана и отправляет — как будто ты набрал и нажал Enter.
 *
 * Стык с Клодианом (проверено по сборке 2.2.6, 24.09.2026):
 *   - окна:        app.workspace.getLeavesOfType('claudian-view') — включая оторванные окна
 *   - вкладка:     .claudian-tab-content (неактивные скрыты классом .claudian-hidden)
 *   - поле ввода:  textarea.claudian-input внутри вкладки
 *   - переписка:   [data-role="user"] (класс .claudian-message-user оставлен запасным)
 *   - очередь:     .claudian-input-queue-row — «⌙ Queued: …», когда агент занят
 *   - команды:     <id>:open-view, <id>:new-tab, где id ищется среди зарегистрированных
 *
 * Чего здесь НЕТ и почему: ожидания занятого агента. Клодиан сам ставит сообщение
 * в очередь, если в этот момент пишет ответ, и показывает это строкой «⌙ Queued».
 * Поэтому плагин просто отправляет и различает три исхода: ушло / поставлено в очередь /
 * не принято. Бейдж вкладки для определения занятости НЕ годится: активная вкладка
 * получает класс -active, а -streaming достаётся только неактивной.
 *
 * Честное ограничение: плагин живёт внутри Обсидиана. Обсидиан закрыт — никто ничего
 * не отправит. Мак спал — при пробуждении сработает проверка просрочки (запас 12 часов).
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal, setIcon, Platform } = require('obsidian');

// ────────────────────────────────────────────────────────────────────────────
// Настройки по умолчанию
// ────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  graceHours: 12,           // опоздание меньше этого — всё равно отправляем при запуске
  checkSec: 20,             // как часто смотреть на часы
  // 'active' — тот чат, что открыт в момент создания (и он же будет активирован перед
  // отправкой), 'current' — какой будет открыт в момент отправки, 'new' — новая вкладка
  defaultTarget: 'active',
  notify: true,             // показывать всплывающие уведомления об отправке
  keepDays: 14,             // сколько дней держать историю отправленных
  writeLog: true,           // вести schedule.log рядом с плагином
};

const PLUGIN_ID = 'claudian-schedule';
const MAX_ATTEMPTS = 20;        // ≈ 7 минут попыток при тике в 20 секунд
const FIVE_YEARS_MS = 5 * 365 * 86400000;

/**
 * Число из настроек может оказаться мусором после ручной правки data.json.
 * Пустоту и «да/нет» берём за «значения нет» — иначе Number(null) = 0 молча
 * превратится в минимум и настройка станет не той, что человек задавал.
 */
function num(value, fallback, min, max) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ────────────────────────────────────────────────────────────────────────────
// Чистые функции: время. Ничего не знают про Обсидиан — проверяются тестами.
// ────────────────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

/** Собрать дату с проверкой: 31.02 и 25:00 должны отвергаться, а не «переползать». */
function buildDate(year, month, day, hh, mm) {
  if (!(month >= 1 && month <= 12)) return null;
  if (!(day >= 1 && day <= 31)) return null;
  if (!(hh >= 0 && hh <= 23)) return null;
  if (!(mm >= 0 && mm <= 59)) return null;
  const d = new Date(year, month - 1, day, hh, mm, 0, 0);
  // 31.02 превратилось бы в 03.03 — такую дату не принимаем
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function finishDate(d, now) {
  const at = d instanceof Date ? d.getTime() : Number(d);
  if (!isFinite(at)) return { error: 'не понял дату' };
  if (at <= now) return { error: 'это время уже прошло' };
  if (at > now + FIVE_YEARS_MS) return { error: 'слишком далеко: дальше пяти лет не планируем' };
  return { at };
}

/**
 * Разбор написанного человеком времени.
 * Возвращает { at: миллисекунды } или { error: 'причина по-русски' }.
 *
 * Молчаливого «ноля» быть не должно: непонятный ввод — это ошибка с причиной,
 * а не «отправлю прямо сейчас» (§🤐 v3.35). Все ветки выходят через finishDate,
 * поэтому NaN и бессмысленные даты наружу не попадают.
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
    return finishDate(now + n * mult, now);
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
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2})(?:[:.](\d{2}))?)?$/);
    if (iso) {
      const d = buildDate(+iso[1], +iso[2], +iso[3], iso[4] ? +iso[4] : 9, iso[5] ? +iso[5] : 0);
      if (!d) return { error: 'такой даты не бывает' };
      return finishDate(d, now);
    }
    const ru = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?:\s*(?:в\s*)?(\d{1,2})(?:[:.](\d{2}))?)?$/);
    if (ru) {
      const nowD = new Date(now);
      let year = ru[3] ? +ru[3] : nowD.getFullYear();
      if (year < 100) year += 2000;
      const hh = ru[4] ? +ru[4] : 9;
      const mm = ru[5] ? +ru[5] : 0;
      let d = buildDate(year, +ru[2], +ru[1], hh, mm);
      if (!d) return { error: 'такой даты не бывает' };
      // «31.12» в январе — это конец года, а не прошедший декабрь
      if (!ru[3] && d.getTime() < now) {
        d = buildDate(year + 1, +ru[2], +ru[1], hh, mm);
        if (!d) return { error: 'такой даты не бывает' };
      }
      return finishDate(d, now);
    }
  }

  // ── только время: «18:00», «18.30», «9» ──
  const t = rest.match(/^(\d{1,2})(?:[:.\-](\d{2}))?$/);
  if (t) {
    const hh = +t[1];
    const mm = t[2] ? +t[2] : 0;
    const base = new Date(now);
    let d = buildDate(base.getFullYear(), base.getMonth() + 1, base.getDate() + (dayShift || 0), hh, mm);
    if (!d) {
      // выход за край месяца: «послезавтра» 30-го числа
      if (hh > 23 || mm > 59) return { error: 'такого времени не бывает: часы 0-23, минуты 0-59' };
      d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (dayShift || 0), hh, mm, 0, 0);
    }
    // «18:00», когда уже 19:00 и день не назван словом → значит завтра, а не в прошлое
    if (dayShift === null && d.getTime() <= now) d = new Date(d.getTime() + 86400000);
    return finishDate(d, now);
  }

  return { error: 'не понял время. Примеры: «через 30 минут», «сегодня 18:00», «завтра 9:00», «24.09 18:30»' };
}

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** «сегодня в 18:00» / «завтра в 09:00» / «26.09 в 18:30» */
function formatWhen(at, now = Date.now()) {
  if (!isFinite(at)) return 'время не разобрано';
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
  if (!isFinite(at)) return 'срок не разобран';
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
 * Что делать с сообщением, время которого уже прошло (мы были выключены или спали).
 * Решение владельца 24.09.2026: опоздание меньше запаса — отправляем, больше — «просрочено».
 */
function decideOverdue(item, now, graceHours) {
  const lateMs = now - item.fireAt;
  if (!isFinite(lateMs)) return 'broken';
  if (lateMs < 0) return 'wait';
  if (lateMs <= graceHours * 3600000) return 'send';
  return 'miss';
}

/** Время из колеса в режиме «в какое время»: прошедшее сегодня переносится на завтра. */
function wheelClockAt(hh, mm, now = Date.now()) {
  return parseWhen(`${pad(hh)}:${pad(mm)}`, now);
}

/** Время из колеса в режиме «через сколько». */
function wheelAfterAt(h, m, now = Date.now()) {
  const total = Number(h) * 60 + Number(m);
  if (!(total > 0)) return { error: 'выбери хотя бы одну минуту' };
  return finishDate(now + total * 60000, now);
}

/**
 * Куда класть сообщение: 'current' (та вкладка, что будет открыта), 'new' (новая)
 * или конкретный чат {title, win, index}.
 */
function normalizeTarget(target) {
  if (target === 'new') return 'new';
  if (target && typeof target === 'object' && target.title) {
    return { title: String(target.title), win: Number(target.win) || 0, index: Number(target.index) || 0 };
  }
  return 'current';
}

/** Как показать выбор человеку. */
function targetLabel(target) {
  if (target === 'new') return 'в новую вкладку';
  if (target && typeof target === 'object' && target.title) return `в чат «${target.title}»`;
  return 'в открытую вкладку';
}

/** Короткая выжимка текста для списков и уведомлений. */
function shortText(text, limit = 70) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > limit ? one.slice(0, limit - 1) + '…' : one;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ────────────────────────────────────────────────────────────────────────────
// Работа с окнами Клодиана.
// Функции получают корни окон извне, поэтому проверяются на настоящем дереве
// страницы (jsdom), а не на самодельной заглушке (§🧫 v3.34).
// ────────────────────────────────────────────────────────────────────────────

const SEL = {
  leaf: '.workspace-leaf-content[data-type="claudian-view"]',
  tab: '.claudian-tab-content',
  input: 'textarea.claudian-input',
  userMsg: '[data-role="user"], .claudian-message-user',
  queue: '.claudian-input-queue-row',
  toolbar: '.claudian-input-toolbar',
  badge: '.claudian-tab-badge',
  badgeActive: 'claudian-tab-badge-active',
  hiddenCls: 'claudian-hidden',
};

/**
 * Список открытых вкладок Клодиана — по значкам в полоске вкладок.
 * Название лежит в aria-label значка («Название, состояние»), щелчок по значку
 * переключает на эту вкладку (проверено по коду Клодиана 2.2.6, renderBadge).
 */
function listTabs(roots) {
  const out = [];
  (roots || []).forEach((root, win) => {
    if (!root || !root.querySelectorAll) return;
    Array.from(root.querySelectorAll(SEL.badge)).forEach((el, index) => {
      const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      const title = norm(aria.replace(/,[^,]*$/, '')) || `вкладка ${index + 1}`;
      out.push({
        title, index, win, el,
        active: !!(el.classList && el.classList.contains(SEL.badgeActive)),
      });
    });
  });
  return out;
}

/** Найти вкладку по сохранённой примете: сперва по названию и окну, потом по месту. */
function matchTab(tabs, want) {
  if (!want) return null;
  const byTitle = tabs.filter(t => t.title === want.title);
  if (byTitle.length === 1) return byTitle[0];
  const exact = byTitle.find(t => t.win === want.win);
  if (exact) return exact;
  if (byTitle.length) return byTitle[0];
  return tabs.find(t => t.win === want.win && t.index === want.index) || null;
}

/** Есть ли в документе раскладка (в тестовой среде её нет — размеры всегда нулевые). */
function hasLayout(doc) {
  const b = doc && doc.body;
  return !!(b && b.getClientRects && b.getClientRects().length);
}

/** Спрятан ли элемент явно — классом Клодиана, стилем или атрибутом. */
function isHiddenEl(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.classList && n.classList.contains(SEL.hiddenCls)) return true;
    const st = (n.getAttribute && n.getAttribute('style')) || '';
    if (/display\s*:\s*none/.test(st) || /visibility\s*:\s*hidden/.test(st)) return true;
    if (n.hasAttribute && n.hasAttribute('hidden')) return true;
  }
  return false;
}

/** Виден ли элемент человеку. */
function isUsable(el) {
  if (!el) return false;
  if (isHiddenEl(el)) return false;
  if (hasLayout(el.ownerDocument)) return !!(el.getClientRects && el.getClientRects().length);
  return true;
}

function collect(roots, selector) {
  const out = [];
  for (const root of roots || []) {
    if (!root || !root.querySelectorAll) continue;
    for (const el of root.querySelectorAll(selector)) out.push(el);
  }
  return out;
}

/** Поле ввода активной вкладки Клодиана. */
function activeInput(roots) {
  for (const el of collect(roots, SEL.input)) if (isUsable(el)) return el;
  return null;
}

/**
 * Свободное поле ввода — им пользуемся после открытия новой вкладки.
 * Свободное значит: видимое и пустое (чужой черновик не трогаем).
 * Идём с конца: новая вкладка добавляется последней.
 */
function freeInput(roots) {
  const list = collect(roots, SEL.input).reverse();
  for (const el of list) if (isUsable(el) && !(el.value || '').trim()) return el;
  return null;
}

/** Вкладка, которой принадлежит поле ввода. Сообщения соседних вкладок лежат рядом в DOM. */
function tabOf(input) {
  if (!input) return null;
  return (input.closest && (input.closest(SEL.tab) || input.closest(SEL.leaf))) || input.ownerDocument;
}

function countUserMessages(input) {
  const tab = tabOf(input);
  return tab ? tab.querySelectorAll(SEL.userMsg).length : 0;
}

function queueText(input) {
  const tab = tabOf(input);
  const q = tab && tab.querySelector(SEL.queue);
  return q ? norm(q.textContent) : '';
}

/**
 * Чем кончилась отправка. Три исхода:
 *   'отправлено'  — сообщение появилось в переписке;
 *   'в очереди'   — Клодиан был занят и поставил его в очередь («⌙ Queued»), ответит следом;
 *   null          — ничего не произошло.
 */
function sendOutcome(input, text, before) {
  const chunk = norm(text).slice(0, 24);
  const tab = tabOf(input);
  if (!tab) return null;

  const users = tab.querySelectorAll(SEL.userMsg);
  if (users.length > before) {
    const last = norm(users[users.length - 1].textContent);
    if (!chunk || last.includes(chunk)) return 'отправлено';
  }
  if (chunk && queueText(input).includes(chunk)) return 'в очереди у Клодиана — ответит следом';
  return null;
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

function fireInput(el) {
  const win = (el.ownerDocument && el.ownerDocument.defaultView) || globalThis;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
}

/**
 * Доставка сообщения в чат.
 *
 * env = {
 *   roots(),                 корни окон Клодиана (учитывая оторванные окна)
 *   run(suffix),             выполнить команду Клодиана: 'open-view' | 'new-tab'; false = не вышло
 *   sleep(ms),
 *   requireMod, modKnown,    настройка «отправка на Cmd/Ctrl+Enter» и удалось ли её прочитать
 *   isMac,
 *   verifyTimeoutMs
 * }
 *
 * { ok: true, via, note } — ушло; { ok: false, retry, reason } — помеха; { ok: false, reason } — отказ.
 */
async function deliverText(env, text, target) {
  const sleep = env.sleep;
  const verifyTimeoutMs = env.verifyTimeoutMs == null ? 25000 : env.verifyTimeoutMs;
  const startedAt = (env.now ? env.now() : Date.now()) - 2000;
  let viaNote = '';

  // 0. Нужна определённая вкладка — переключаемся на неё щелчком по значку.
  //    Это же решает случай «Обсидиан в другом окне»: активная вкладка станет нашей.
  const wantTab = (target && typeof target === 'object' && target.title) ? target : null;
  if (wantTab) {
    const found = matchTab(listTabs(env.roots()), wantTab);
    if (!found) {
      viaNote = `вкладка «${wantTab.title}» не найдена, положил в открытую`;
    } else if (!found.active && found.el && found.el.click) {
      found.el.click();
      await sleep(500);
    }
  }

  let input = activeInput(env.roots());

  // 1. Окно Клодиана закрыто — открываем сами. Не вышло — это помеха, а не отказ:
  //    Клодиан мог ещё не прогрузиться после запуска Обсидиана.
  if (!input) {
    const opened = await env.run('open-view');
    await sleep(800);
    input = activeInput(env.roots());
    if (!input) {
      return { ok: false, retry: true, reason: opened === false ? 'Клодиан не откликнулся на команду открытия' : 'окно Клодиана ещё не открылось' };
    }
  }

  // 2. Куда класть. В поле есть черновик — не трогаем его, уходим в новую вкладку.
  let via = target === 'new' ? 'new' : 'current';
  if (via === 'current' && (input.value || '').trim()) via = 'new';

  if (via === 'new') {
    const opened = await env.run('new-tab');
    await sleep(800);
    const fresh = freeInput(env.roots());
    if (!fresh) {
      // свободного поля нет: либо вкладка не открылась, либо везде чужие черновики.
      // Это помеха, а не отказ — вернёмся на следующем тике.
      return {
        ok: false, retry: true,
        reason: opened === false ? 'Клодиан не дал открыть новую вкладку' : 'новая вкладка не открылась',
      };
    }
    // Вкладку открыть не вышло (у Клодиана есть предел), но есть свободное поле —
    // лучше доставить туда и сказать об этом, чем молча держать сообщение.
    if (opened === false) viaNote = 'новую вкладку открыть не вышло, положил в свободную';
    input = fresh;
  }

  // 3. Вставляем и отправляем
  const before = countUserMessages(input);
  input.value = text;
  fireInput(input);
  if (input.focus) input.focus();
  pressEnter(input, env.requireMod, env.isMac);

  // 4. Проверяем ИСХОД, а не попытку (§🎯 v2.85, §👁 v3.16).
  //    Повторное нажатие — только если настройку прочитать не удалось И поле не тронуто:
  //    у Клодиана при выключенном «Cmd+Enter» проходят ОБА нажатия, и вслепую
  //    подстрахованное второе отправляет сообщение дважды.
  const done = (note) => ({ ok: true, via, note: viaNote ? `${viaNote}, ${note}` : note });
  const step = 200;
  let waited = 0;
  let repressed = env.modKnown === true;
  while (waited < verifyTimeoutMs) {
    const outcome = sendOutcome(input, text, before);
    if (outcome) return done(outcome);

    // Окно Обсидиана может быть в фоне — тогда Клодиан принимает сообщение сразу,
    // а рисует его на экране позже. Поэтому кроме экрана смотрим запись на диске:
    // Клодиан складывает принятые сообщения в .claudian/sessions/*.inputs.json.
    // Именно этот случай 25.09.2026 дал ложное «не ушло».
    if (env.durable && waited > 0 && waited % 2000 === 0) {
      const rec = await env.durable(text, startedAt);
      if (rec) return done(rec.where ? `принято Клодианом (беседа ${rec.where})` : 'принято Клодианом');
    }

    if (!repressed && waited >= 1500 && (input.value || '') === text) {
      pressEnter(input, !env.requireMod, env.isMac);
      repressed = true;
    }
    await sleep(step);
    waited += step;
  }

  // 5. Последняя проверка на диске — вдруг успело между заходами
  if (env.durable) {
    const rec = await env.durable(text, startedAt);
    if (rec) return done(rec.where ? `принято Клодианом (беседа ${rec.where})` : 'принято Клодианом');
  }

  // 6. Поле опустело, а текст наш никуда не делся из виду — значит Клодиан его забрал.
  //    Слабое доказательство, поэтому говорим об этом прямо.
  if (!(input.value || '').trim()) {
    return done('поле опустело — похоже, Клодиан принял, но подтверждения в переписке нет');
  }

  // 7. Не ушло — убираем свой текст, чтобы не оставлять мусор в поле
  if ((input.value || '') === text) {
    input.value = '';
    fireInput(input);
  }
  return { ok: false, reason: 'Клодиан не принял сообщение (в переписке оно не появилось)' };
}

/**
 * Поиск записи о принятом сообщении в хранилище Клодиана.
 * Разбирается с настоящими файлами, поэтому проверяется тестом на временной папке.
 *
 * fsMod / pathMod передаются снаружи, чтобы функция не зависела от среды.
 */
function findDurableRecord(fsMod, pathMod, sessionsDir, text, sinceMs) {
  const want = norm(text);
  if (!want) return null;
  let files;
  try { files = fsMod.readdirSync(sessionsDir); } catch (e) { return null; }
  for (const name of files) {
    if (!name.endsWith('.inputs.json')) continue;
    const full = pathMod.join(sessionsDir, name);
    try {
      // файл мог не меняться с момента отправки — тогда и смотреть нечего
      if (fsMod.statSync(full).mtimeMs < sinceMs) continue;
      const data = JSON.parse(fsMod.readFileSync(full, 'utf8'));
      const recs = Array.isArray(data.records) ? data.records : [];
      for (let i = recs.length - 1; i >= 0 && i >= recs.length - 10; i--) {
        const r = recs[i];
        if (!r || typeof r.timestamp !== 'number' || r.timestamp < sinceMs) continue;
        if (norm(r.rawDisplayText || r.canonicalText || '') === want) {
          return { where: name.replace(/\.inputs\.json$/, ''), timestamp: r.timestamp, state: r.state };
        }
      }
    } catch (e) { /* испорченный или занятый файл — просто пропускаем */ }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Плагин
// ────────────────────────────────────────────────────────────────────────────

class ClaudianSchedulePlugin extends Plugin {
  async onload() {
    await this.loadState();

    this.working = false;         // один заход отправки за раз
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

    this.restartTimer();
    this.registerInterval(window.setInterval(() => this.mountButtons(), 2000));

    // Проверка просрочки — когда интерфейс уже собран, иначе окна Клодиана ещё нет
    this.app.workspace.onLayoutReady(() => {
      const h = window.setTimeout(() => this.startupCheck(), 3000);
      this.register(() => window.clearTimeout(h));
      this.mountButtons();
    });
  }

  onunload() {
    if (this.tickHandle) window.clearInterval(this.tickHandle);
    this.buttons.forEach(b => b.remove());
    this.buttons.clear();
  }

  /** Часы пересоздаём при смене настройки — иначе ползунок не действует до перезапуска. */
  restartTimer() {
    if (this.tickHandle) window.clearInterval(this.tickHandle);
    const sec = num(this.settings.checkSec, DEFAULTS.checkSec, 5, 300);
    this.tickHandle = window.setInterval(() => this.tick(), sec * 1000);
    this.registerInterval(this.tickHandle);
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

  grace() { return num(this.settings.graceHours, DEFAULTS.graceHours, 1, 48); }

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
      target: normalizeTarget(target),
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
    const edge = Date.now() - num(this.settings.keepDays, DEFAULTS.keepDays, 1, 365) * 86400000;
    const before = this.items.length;
    this.items = this.items.filter(i =>
      i.status === 'pending' || i.status === 'sending' || (i.sentAt || i.fireAt) > edge);
    if (this.items.length !== before) await this.save();
  }

  // ── Часы ─────────────────────────────────────────────────────────────────

  /** Запуск Обсидиана: подчистить историю и сразу проверить, что проспали. */
  async startupCheck() {
    await this.prune();
    await this.tick();
  }

  /**
   * Один заход часов: разобраться с просрочкой и отправить, чему пришло время.
   * Просрочка проверяется ЗДЕСЬ, а не только при запуске: после сна Мака Обсидиан
   * не перезагружается, работает только этот тик.
   */
  async tick() {
    if (this.working) return;
    this.working = true;
    try {
      const now = Date.now();
      const grace = this.grace();
      const missed = [];
      let changed = false;

      for (const item of this.items) {
        if (item.status !== 'pending' && item.status !== 'sending') continue;
        if (item.status === 'sending') { item.status = 'pending'; changed = true; } // обрыв прошлого сеанса
        const what = decideOverdue(item, now, grace);
        if (what === 'broken') {
          item.status = 'failed';
          item.note = 'время сообщения испорчено — задай его заново';
          item.sentAt = now;
          changed = true;
        } else if (what === 'miss') {
          item.status = 'missed';
          item.note = `Обсидиан был закрыт, опоздание ${humanLeft(item.fireAt, now)}`;
          missed.push(item);
          changed = true;
          this.log(`просрочено | ${formatWhen(item.fireAt, now)} | «${shortText(item.text, 50)}»`);
        }
      }
      if (changed) await this.save();
      if (missed.length) {
        new Notice(
          `Отложенные сообщения: ${missed.length} не ушло — опоздание больше ${grace} ч. ` +
          `Открой список, чтобы отправить или удалить.`, 10000);
      }

      const due = this.pending().filter(i => i.fireAt <= now);
      for (const item of due) await this.fire(item, now);
    } finally {
      this.working = false;
      this.renderStatus();
    }
  }

  /** Отправка одного сообщения. Вызывается только из tick() и fireNow() — оба под замком. */
  async fire(item, now = Date.now()) {
    item.status = 'sending';
    item.attempts = (item.attempts || 0) + 1;
    await this.save();

    // Любая неожиданная поломка не должна оставить сообщение навсегда в «отправляется»
    let res;
    try {
      res = await deliverText(this.env(), item.text, item.target);
    } catch (e) {
      res = { ok: false, reason: `сбой при отправке: ${e && e.message ? e.message : e}` };
      console.error('[claudian-schedule] сбой доставки:', e);
    }

    if (res.ok) {
      item.status = 'sent';
      item.sentAt = Date.now();
      item.note = res.via === 'new' ? `новая вкладка, ${res.note}` : res.note;
      await this.save();
      this.log(`отправлено | ${item.note} | «${shortText(item.text, 50)}»`);
      if (this.settings.notify) new Notice(`Клодиану отправлено: «${shortText(item.text, 60)}»`, 6000);
      return;
    }

    // Помеха — вернёмся на следующем тике, но не бесконечно
    if (res.retry && item.attempts < MAX_ATTEMPTS) {
      item.status = 'pending';
      item.note = `${res.reason} — попытка ${item.attempts} из ${MAX_ATTEMPTS}`;
      await this.save();
      this.log(`ждём | ${res.reason} | попытка ${item.attempts} | «${shortText(item.text, 50)}»`);
      return;
    }

    item.status = 'failed';
    item.note = res.retry
      ? `не вышло за ${item.attempts} попыток: ${res.reason}`
      : (res.reason || 'не удалось отправить');
    item.sentAt = Date.now();
    await this.save();
    this.log(`НЕ УДАЛОСЬ | ${item.note} | «${shortText(item.text, 50)}»`);
    new Notice(`Отложенное сообщение не ушло: ${item.note}`, 12000);
  }

  /** Отправить прямо сейчас (кнопка в списке) — под тем же замком, что и часы. */
  async fireNow(item) {
    if (this.working) { new Notice('Сейчас идёт отправка — подожди пару секунд'); return; }
    this.working = true;
    try {
      item.status = 'pending';
      item.attempts = 0;
      await this.fire(item, Date.now());
    } finally {
      this.working = false;
      this.renderStatus();
    }
  }

  // ── Стык с Клодианом ─────────────────────────────────────────────────────

  /** Корни всех окон Клодиана, включая оторванные в отдельное окно. */
  claudianRoots() {
    let roots = [];
    try {
      const leaves = this.app.workspace.getLeavesOfType('claudian-view') || [];
      roots = leaves.map(l => l && l.view && l.view.containerEl).filter(Boolean);
    } catch (e) { /* ниже запасной путь */ }
    return roots.length ? roots : [document];
  }

  /**
   * Команда Клодиана по окончанию имени. Id зашивать нельзя: наш Клодиан — форк
   * (`realclaudian`), апстрим живёт под `claudian`.
   * Возвращает false, если команда не найдена или отказалась выполняться.
   */
  runClaudianCommand(suffix) {
    try {
      const all = this.app.commands.commands || {};
      const id = [`realclaudian:${suffix}`, `claudian:${suffix}`].find(x => all[x])
        || Object.keys(all).find(x => x.endsWith(`:${suffix}`) && /claudian/i.test(x));
      if (!id) return false;
      return this.app.commands.executeCommandById(id) !== false;
    } catch (e) {
      console.warn('[claudian-schedule] команда Клодиана не выполнилась:', e);
      return false;
    }
  }

  env() {
    let requireMod = false;
    let modKnown = false;
    try {
      const rc = this.app.plugins.plugins['realclaudian'] || this.app.plugins.plugins['claudian'];
      const v = rc && rc.settings && rc.settings.requireCommandOrControlEnterToSend;
      if (typeof v === 'boolean') { requireMod = v; modKnown = true; }
    } catch (e) { /* не прочитали — подстрахуемся вторым нажатием */ }
    return {
      roots: () => this.claudianRoots(),
      run: (suffix) => this.runClaudianCommand(suffix),
      sleep: (ms) => new Promise(r => window.setTimeout(r, ms)),
      durable: async (text, since) => this.durableCheck(text, since),
      requireMod,
      modKnown,
      isMac: typeof Platform !== 'undefined' ? !!Platform.isMacOS : true,
    };
  }

  /** Принял ли Клодиан сообщение на самом деле — по его же записи на диске. */
  durableCheck(text, since) {
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(this.app.vault.adapter.getBasePath(), '.claudian', 'sessions');
      return findDurableRecord(fs, path, dir, text, since);
    } catch (e) {
      return null;
    }
  }

  /** Открытые вкладки Клодиана — для выбора в окне создания. */
  tabs() {
    return listTabs(this.claudianRoots()).map(t => ({
      title: t.title, index: t.index, win: t.win, active: t.active,
    }));
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
    // Клодиан пересобирает панель при переключении вкладок — выбрасываем из учёта
    // кнопки, которых уже нет на странице, иначе список растёт всю сессию
    this.buttons.forEach(b => { if (!b.isConnected) this.buttons.delete(b); });
    collect(this.claudianRoots(), SEL.toolbar).forEach(tb => {
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
    const input = activeInput(this.claudianRoots());
    const text = input ? input.value : '';
    this.openComposer(text, () => {
      if (!input) return;
      input.value = '';
      fireInput(input);
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
// Колесо выбора времени — как в часах на айфоне
// ────────────────────────────────────────────────────────────────────────────

const WHEEL_ITEM_H = 34;   // высота строки колеса в точках, та же цифра в styles.css

function range(n) { return Array.from({ length: n }, (_, i) => i); }

/** Какое деление колеса сейчас в середине. Чистая функция — проверяется тестом. */
function wheelIndexFromScroll(scrollTop, itemH, count) {
  const h = itemH > 0 ? itemH : 1;
  const i = Math.round((Number(scrollTop) || 0) / h);
  return Math.min(Math.max(count - 1, 0), Math.max(0, i));
}

/**
 * Прокручиваемое колесо значений. Пролистывается пальцем, колесом мыши и щелчком
 * по нужной цифре; выбранное деление подсвечивается, как в айфоне.
 */
function makeWheel(parent, values, initial, label, onChange) {
  const box = parent.createDiv({ cls: 'cs-wheel' });
  const scroller = box.createDiv({ cls: 'cs-wheel-scroll' });
  scroller.createDiv({ cls: 'cs-wheel-pad' });
  values.forEach((v, i) => {
    const it = scroller.createDiv({ cls: 'cs-wheel-item', text: pad(v) });
    it.onclick = () => api.set(i, true);
  });
  scroller.createDiv({ cls: 'cs-wheel-pad' });
  box.createDiv({ cls: 'cs-wheel-label', text: label });

  let idx = Math.max(0, values.indexOf(initial));
  let timer = null;

  const paint = () => {
    Array.from(scroller.querySelectorAll('.cs-wheel-item')).forEach((el, i) => {
      if (i === idx) el.addClass('cs-wheel-on'); else el.removeClass('cs-wheel-on');
    });
  };

  const api = {
    set(i, smooth) {
      idx = Math.min(values.length - 1, Math.max(0, i));
      const top = idx * WHEEL_ITEM_H;
      if (scroller.scrollTo) scroller.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
      else scroller.scrollTop = top;
      paint();
      onChange(values[idx]);
    },
    value: () => values[idx],
  };

  scroller.addEventListener('scroll', () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const i = wheelIndexFromScroll(scroller.scrollTop, WHEEL_ITEM_H, values.length);
      const changed = i !== idx;
      idx = i;
      paint();
      if (changed) onChange(values[idx]);
    }, 120);
  });

  // начальное положение — когда колесо уже в документе и у него есть высота
  window.setTimeout(() => { scroller.scrollTop = idx * WHEEL_ITEM_H; paint(); }, 0);
  return api;
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
    this.mode = 'clock';              // 'clock' — в какое время, 'after' — через сколько
    this.hh = 9; this.mm = 0;         // колесо «в какое время»
    this.ah = 0; this.am = 30;        // колесо «через сколько»
    this.whenRaw = '';                // если написано словами — оно главнее колеса
    this.tabs = [];
    this.target = this.item ? this.item.target : plugin.settings.defaultTarget;
    this.onScheduled = opts.onScheduled;
    this.onDone = opts.onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('cs-modal');
    contentEl.createEl('h3', { text: this.item ? 'Перенести сообщение' : 'Отложить сообщение Клодиану' });

    // ── Сообщение ──
    contentEl.createEl('label', { text: 'Сообщение', cls: 'cs-label' });
    const ta = contentEl.createEl('textarea', { cls: 'cs-text' });
    ta.value = this.text;
    ta.placeholder = 'Что Клодиан должен получить в назначенное время…';
    ta.rows = 5;
    ta.oninput = () => { this.text = ta.value; this.refresh(); };

    // ── Когда: переключатель режима ──
    contentEl.createEl('label', { text: 'Когда', cls: 'cs-label' });
    const modes = contentEl.createDiv({ cls: 'cs-modes' });
    const mkMode = (key, label) => {
      const b = modes.createEl('button', { text: label, cls: 'cs-mode' });
      b.onclick = () => {
        this.mode = key;
        this.whenRaw = '';
        wordsInput.value = '';
        modes.querySelectorAll('.cs-mode').forEach(x => x.removeClass('cs-mode-on'));
        b.addClass('cs-mode-on');
        clockWrap.toggleClass('cs-hide', key !== 'clock');
        afterWrap.toggleClass('cs-hide', key !== 'after');
        this.refresh();
      };
      return b;
    };
    const bClock = mkMode('clock', 'в какое время');
    const bAfter = mkMode('after', 'через сколько');
    bClock.addClass('cs-mode-on');

    // ── Колёса ──
    const now = new Date();
    this.hh = (now.getHours() + 1) % 24;
    this.mm = 0;

    const clockWrap = contentEl.createDiv({ cls: 'cs-wheels' });
    this.wClockH = makeWheel(clockWrap, range(24), this.hh, 'ч', v => { this.hh = v; this.whenRaw = ''; wordsInput.value = ''; this.refresh(); });
    this.wClockM = makeWheel(clockWrap, range(60), this.mm, 'мин', v => { this.mm = v; this.whenRaw = ''; wordsInput.value = ''; this.refresh(); });

    const afterWrap = contentEl.createDiv({ cls: 'cs-wheels cs-hide' });
    this.wAfterH = makeWheel(afterWrap, range(24), this.ah, 'ч', v => { this.ah = v; this.whenRaw = ''; wordsInput.value = ''; this.refresh(); });
    this.wAfterM = makeWheel(afterWrap, range(60), this.am, 'мин', v => { this.am = v; this.whenRaw = ''; wordsInput.value = ''; this.refresh(); });

    this.preview = contentEl.createDiv({ cls: 'cs-preview' });

    // ── Словами (для «завтра», «26.09 18:30» и прочего) ──
    const words = contentEl.createDiv({ cls: 'cs-words' });
    words.createEl('span', { text: 'или словами: ', cls: 'cs-hint' });
    const wordsInput = words.createEl('input', { cls: 'cs-when', type: 'text' });
    wordsInput.placeholder = 'завтра 9:00 · через 3 дня · 26.09 18:30';
    wordsInput.oninput = () => { this.whenRaw = wordsInput.value; this.refresh(); };
    wordsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
    });

    this.warn = contentEl.createDiv({ cls: 'cs-warn' });

    // ── Куда положить ──
    contentEl.createEl('label', { text: 'Куда положить', cls: 'cs-label' });
    const sel = contentEl.createEl('select', { cls: 'cs-target-sel' });
    this.tabs = this.plugin.tabs();
    const many = this.tabs.some(t => t.win > 0);
    this.tabs.forEach((t, i) => {
      const where = many ? ` · окно ${t.win + 1}` : '';
      const mark = t.active ? ' (открыта сейчас)' : '';
      sel.createEl('option', { text: `в чат «${t.title}»${where}${mark}`, value: `tab:${i}` });
    });
    sel.createEl('option', { text: 'в тот чат, что будет открыт в это время', value: 'current' });
    sel.createEl('option', { text: 'в новую вкладку', value: 'new' });

    // по умолчанию — вкладка, открытая сейчас: это и есть «то окно, где я работаю»
    const activeIdx = this.tabs.findIndex(t => t.active);
    sel.value = this.pickInitialTarget(activeIdx);
    this.applyTarget(sel.value);
    sel.onchange = () => this.applyTarget(sel.value);

    contentEl.createEl('div', {
      cls: 'cs-hint',
      text: 'Выбранный чат плагин сам сделает активным перед отправкой. Если в поле ввода будет черновик — сообщение уйдёт в новую вкладку, набранное не пропадёт. Если Клодиан занят, он поставит сообщение в очередь и ответит следом.',
    });

    // ── Кнопки ──
    const row = contentEl.createDiv({ cls: 'cs-row' });
    this.okBtn = row.createEl('button', { text: this.item ? 'Перенести' : 'Запланировать', cls: 'mod-cta' });
    this.okBtn.onclick = () => this.submit();
    const cancel = row.createEl('button', { text: 'Отмена' });
    cancel.onclick = () => this.close();

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.submit(); }
    });

    this.refresh();
    window.setTimeout(() => ta.focus(), 30);
  }

  /** Что выбрать в списке «куда» при открытии окна. */
  pickInitialTarget(activeIdx) {
    const t = this.target;
    if (t === 'new') return 'new';
    if (t && typeof t === 'object' && t.title) {
      const i = this.tabs.findIndex(x => x.title === t.title && x.win === t.win);
      if (i >= 0) return `tab:${i}`;             // сохранённый чат ещё открыт
    }
    if (this.item) return 'current';             // перенос: чужой выбор молча не меняем
    if (t === 'current') return 'current';
    if (activeIdx >= 0) return `tab:${activeIdx}`; // по умолчанию — чат, открытый сейчас
    return 'current';
  }

  applyTarget(value) {
    if (value === 'new' || value === 'current') { this.target = value; return; }
    const i = Number(String(value).split(':')[1]);
    const t = this.tabs[i];
    this.target = t ? { title: t.title, win: t.win, index: t.index } : 'current';
  }

  /** Время, которое сейчас выбрано: слова важнее колеса. */
  chosen() {
    if (String(this.whenRaw).trim()) return parseWhen(this.whenRaw);
    if (this.mode === 'after') return wheelAfterAt(this.ah, this.am);
    return wheelClockAt(this.hh, this.mm);
  }

  refresh() {
    const res = this.chosen();
    const okText = !!String(this.text).trim();
    if (res.error) {
      this.preview.setText(`⚠️ ${res.error}`);
      this.preview.removeClass('cs-ok');
    } else {
      this.preview.setText(`Уйдёт ${formatWhen(res.at)} — это ${humanLeft(res.at)}`);
      this.preview.addClass('cs-ok');
    }
    // Текст со слэша Клодиан примет за свою команду (/clear, /help и прочие)
    if (String(this.text).trim().startsWith('/')) {
      this.warn.setText('⚠️ Сообщение начинается со слэша — Клодиан примет его за свою команду, а не за текст. Добавь слово перед слэшем, если это не задумано.');
    } else {
      this.warn.setText('');
    }
    if (this.okBtn) this.okBtn.disabled = !!res.error || !okText;
  }

  async submit() {
    const text = String(this.text).trim();
    if (!text) { new Notice('Сначала напиши сообщение'); return; }
    const res = this.chosen();
    if (res.error) { new Notice(`Время: ${res.error}`); return; }

    if (this.item) {
      this.item.text = text;
      this.item.fireAt = res.at;
      this.item.target = this.target;
      this.item.status = 'pending';
      this.item.attempts = 0;
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
    head.createEl('span', { cls: 'cs-hint', text: ` · ${targetLabel(item.target)}` });
    el.createDiv({ cls: 'cs-item-text', text: shortText(item.text, 200) });
    if (item.note) el.createDiv({ cls: 'cs-hint', text: item.note });

    const row = el.createDiv({ cls: 'cs-row' });
    if (isPending || item.status === 'missed' || item.status === 'failed') {
      const now = row.createEl('button', { text: 'Отправить сейчас' });
      now.onclick = async () => {
        now.disabled = true;
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
      .addSlider(sl => sl.setLimits(1, 48, 1).setValue(this.plugin.grace()).setDynamicTooltip()
        .onChange(async v => { s.graceHours = v; await save(); }));

    new Setting(containerEl)
      .setName('Куда класть по умолчанию')
      .setDesc('В окне создания это можно менять для каждого сообщения — там же виден список открытых чатов.')
      .addDropdown(d => d
        .addOption('active', 'в тот чат, где я пишу сейчас')
        .addOption('current', 'в тот, что будет открыт в момент отправки')
        .addOption('new', 'в новую вкладку')
        .setValue(['active', 'current', 'new'].includes(s.defaultTarget) ? s.defaultTarget : 'active')
        .onChange(async v => { s.defaultTarget = v; await save(); }));

    new Setting(containerEl)
      .setName('Как часто смотреть на часы')
      .setDesc('В секундах. Реже — меньше суеты, точность отправки падает на это же время.')
      .addSlider(sl => sl.setLimits(10, 120, 5).setValue(num(s.checkSec, DEFAULTS.checkSec, 10, 120)).setDynamicTooltip()
        .onChange(async v => { s.checkSec = v; await save(); this.plugin.restartTimer(); }));

    new Setting(containerEl)
      .setName('Показывать уведомление при отправке')
      .addToggle(t => t.setValue(s.notify !== false).onChange(async v => { s.notify = v; await save(); }));

    new Setting(containerEl)
      .setName('Хранить историю, дней')
      .addSlider(sl => sl.setLimits(1, 90, 1).setValue(num(s.keepDays, DEFAULTS.keepDays, 1, 90)).setDynamicTooltip()
        .onChange(async v => { s.keepDays = v; await save(); }));

    new Setting(containerEl)
      .setName('Вести журнал')
      .setDesc('Файл schedule.log рядом с плагином: что и когда ушло. Нужен, чтобы разбирать «почему не отправилось» по факту.')
      .addToggle(t => t.setValue(s.writeLog !== false).onChange(async v => { s.writeLog = v; await save(); }));

    const help = containerEl.createDiv({ cls: 'cs-help' });
    help.createEl('h4', { text: 'Как пользоваться' });
    const ul = help.createEl('ul');
    ul.createEl('li', { text: '⏰ — кнопка в панели ввода Клодиана: набрал сообщение, нажал часы, выбрал время.' });
    ul.createEl('li', { text: 'Cmd+P → «Отложить сообщение Клодиану» — то же самое из любого места.' });
    ul.createEl('li', { text: 'Счётчик ⏰ внизу окна показывает, сколько сообщений ждёт. Клик — список.' });
    ul.createEl('li', { text: 'Время пишется по-человечески: «через 30 минут», «сегодня 18:00», «завтра 9:00», «24.09 18:30».' });
    ul.createEl('li', { text: 'Если Клодиан занят, он поставит сообщение в очередь и ответит следом — ждать не нужно.' });
  }
}

module.exports = ClaudianSchedulePlugin;

// Внутренности — для тестов (в Обсидиане не используются)
module.exports._internals = {
  parseWhen, formatWhen, humanLeft, decideOverdue, shortText, buildDate, num,
  activeInput, freeInput, tabOf, countUserMessages, queueText, sendOutcome,
  deliverText, isUsable, SEL, DEFAULTS, MAX_ATTEMPTS,
  listTabs, matchTab, findDurableRecord, normalizeTarget, targetLabel,
  wheelClockAt, wheelAfterAt, wheelIndexFromScroll, range,
};
