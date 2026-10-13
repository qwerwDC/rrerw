#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;
const PROFILE_DIR = path.join(__dirname, 'vex_profile');
const CONFIG_FILE = path.join(__dirname, 'vex_config.json');

const DEFAULT_KEY = 'gsk_3WybN0cfZCO69pa6HiZV' + 'WGdyb3FYCE5pMTmQZF3maFD464uiTf9r';

// Загрузка/сохранение настроек и пула API-ключей
let config = {
  model: 'openai/gpt-oss-120b',
  defaultMaxSteps: 60,
  apiKeys: [DEFAULT_KEY]
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (Array.isArray(saved.apiKeys) && saved.apiKeys.length > 0) {
        config = { ...config, ...saved };
      }
    }
  } catch (e) {}
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {}
}

loadConfig();

// Статистика и состояние ротации ключей
let activeKeyIndex = 0;
let keyStats = {};

function syncKeyStats() {
  const nextStats = {};
  config.apiKeys.forEach((k, idx) => {
    const masked = k.slice(0, 8) + '...' + k.slice(-4);
    nextStats[k] = keyStats[k] || {
      index: idx + 1,
      masked,
      calls: 0,
      errors: 0,
      status: 'READY',
      lastUsed: '—'
    };
    nextStats[k].index = idx + 1;
    nextStats[k].masked = masked;
  });
  keyStats = nextStats;
  if (activeKeyIndex >= config.apiKeys.length) activeKeyIndex = 0;
}
syncKeyStats();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let page = null;

const state = {
  isRunning: false,
  shouldStop: false,
  goal: '',
  step: 0,
  maxSteps: config.defaultMaxSteps || 60,
  currentUrl: 'https://www.youtube.com',
  statusText: 'Готов к запуску',
  finalAnswer: '',
  activeKeyNum: 1,
  totalKeys: config.apiKeys.length,
  rotationsCount: 0,
  logs: [],
  lastScreenshot: ''
};

function addLog(msg) {
  const time = new Date().toLocaleTimeString('ru-RU');
  state.logs.push(`[${time}] ${msg}`);
  if (state.logs.length > 120) state.logs.shift();
  console.log(`[VEXCLOUD] ${msg}`);
}

// Запрос к Groq с АВТОМАТИЧЕСКОЙ РОТАЦИЕЙ ключей при лимите (429 / 401 / 503)
async function callGroqWithRotation(messages) {
  const keys = config.apiKeys.filter((k) => k && k.trim().length > 10);
  if (keys.length === 0) throw new Error('Нет добавленных API-ключей в настройках!');

  let attempts = 0;
  const maxAttempts = keys.length * 2;

  while (attempts < maxAttempts) {
    if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
    const currentKey = keys[activeKeyIndex];
    const stat = keyStats[currentKey];
    state.activeKeyNum = activeKeyIndex + 1;
    state.totalKeys = keys.length;

    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentKey}`
        },
        body: JSON.stringify({
          model: config.model || 'openai/gpt-oss-120b',
          messages,
          temperature: 0.2,
          max_tokens: 650
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (stat) {
          stat.calls++;
          stat.status = 'ACTIVE ⚡';
          stat.lastUsed = new Date().toLocaleTimeString('ru-RU');
        }
        return data;
      }

      const errText = await res.text();
      if (stat) {
        stat.errors++;
        stat.status = res.status === 429 ? 'LIMIT (429) ⏳' : `ERR (${res.status})`;
      }

      // Если лимит (429) или ошибка ключа — мгновенно переключаемся на следующий ключ!
      const prevKeyNum = activeKeyIndex + 1;
      activeKeyIndex = (activeKeyIndex + 1) % keys.length;
      state.rotationsCount++;
      attempts++;

      if (keys.length > 1) {
        addLog(`🔄 Лимит/ошибка на Ключе #${prevKeyNum} (код ${res.status}). Мгновенное переключение на Ключ #${activeKeyIndex + 1}!`);
        await sleep(300);
      } else {
        addLog(`⏳ Лимит на единственном ключе (429). Жду 4 секунды для автопродолжения...`);
        await sleep(4000);
      }
    } catch (netErr) {
      activeKeyIndex = (activeKeyIndex + 1) % keys.length;
      attempts++;
      await sleep(1000);
    }
  }

  throw new Error('Все API-ключи сейчас достигли лимита. Добавьте еще ключей или подождите минуту.');
}

// Запуск фонового Chrome с сохранением профиля и аккаунтов
async function ensureBrowser() {
  if (browser && browser.connected) {
    const pages = await browser.pages();
    const alive = pages.filter((p) => !p.isClosed());
    if (alive.length > 0) {
      page = alive[alive.length - 1];
      return;
    }
    page = await browser.newPage();
    return;
  }

  addLog('🌐 Запуск облачного браузера Chrome с памятью профиля...');
  const launchOpts = {
    headless: 'new',
    userDataDir: PROFILE_DIR,
    defaultViewport: { width: 1280, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800'
    ]
  };

  // автопоиск встроенного браузера Puppeteer

  browser = await puppeteer.launch(launchOpts);

  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      try {
        const newP = await target.page();
        if (newP) {
          page = newP;
          await page.setViewport({ width: 1280, height: 800 }).catch(() => {});
        }
      } catch (e) {}
    }
  });

  const pages = await browser.pages();
  page = pages[0] || (await browser.newPage());
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  );

  if (page.url() === 'about:blank') {
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await updateScreenshot();
}

async function updateScreenshot() {
  if (!page || page.isClosed()) return;
  try {
    state.currentUrl = page.url();
    const b64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 68 });
    state.lastScreenshot = 'data:image/jpeg;base64,' + b64;
  } catch (e) {}
}

setInterval(() => {
  if (page && !page.isClosed()) updateScreenshot();
}, 1100);

// Умное сканирование DOM + отрисовка улучшенного курсора и меток (безопасно для YouTube TrustedHTML)
async function scanPage(page) {
  return await page.evaluate(() => {
    if (!document.getElementById('vex-pro-styles')) {
      const st = document.createElement('style');
      st.id = 'vex-pro-styles';
      st.textContent = `
        #vex-cursor-wrap {
          position: fixed; left: 640px; top: 400px;
          z-index: 2147483647; pointer-events: none;
          transition: left 0.34s cubic-bezier(0.22, 1, 0.36, 1), top 0.34s cubic-bezier(0.22, 1, 0.36, 1), transform 0.14s ease;
        }
        #vex-cursor-ring {
          position: absolute; left: -16px; top: -16px;
          width: 32px; height: 32px; border: 2px solid #00f0ff;
          border-radius: 50%; background: rgba(0, 240, 255, 0.14);
          box-shadow: 0 0 18px #00f0ff, inset 0 0 8px #ff2a85;
        }
        #vex-cursor-dot {
          position: absolute; left: -4px; top: -4px;
          width: 8px; height: 8px; background: #ff2a85;
          border-radius: 50%; box-shadow: 0 0 10px #ff2a85;
        }
        #vex-cursor-tag {
          position: absolute; left: 20px; top: -8px;
          background: linear-gradient(90deg, #ff2a85, #7928ca);
          color: #fff; font-family: monospace; font-size: 11px;
          font-weight: bold; padding: 3px 8px; border-radius: 5px;
          white-space: nowrap; box-shadow: 0 4px 12px rgba(0,0,0,0.65);
          border: 1px solid #00f0ff;
        }
        .vex-click-wave {
          position: fixed; width: 24px; height: 24px;
          margin-left: -12px; margin-top: -12px;
          border: 3px solid #ff2a85; border-radius: 50%;
          pointer-events: none; z-index: 2147483646;
          animation: vexWave 0.6s ease-out forwards;
        }
        @keyframes vexWave {
          0% { transform: scale(0.4); opacity: 1; border-color: #00f0ff; }
          100% { transform: scale(4.0); opacity: 0; border-color: #ff2a85; }
        }
        .vex-badge {
          position: fixed; z-index: 2147483645; pointer-events: none;
          background: #06060c; color: #00f0ff;
          border: 1px solid #00f0ff; font-family: monospace;
          font-size: 10px; font-weight: bold; padding: 0px 4px;
          border-radius: 3px; line-height: 14px;
          box-shadow: 0 2px 5px rgba(0,0,0,0.7);
        }
        .vex-badge.clicked {
          border-color: #ff2a85; color: #ff2a85; opacity: 0.7;
        }
      `;
      document.head.appendChild(st);
    }

    let cursorWrap = document.getElementById('vex-cursor-wrap');
    if (!cursorWrap) {
      cursorWrap = document.createElement('div');
      cursorWrap.id = 'vex-cursor-wrap';
      cursorWrap.style.left = (window.__vexX || 640) + 'px';
      cursorWrap.style.top = (window.__vexY || 400) + 'px';

      const ring = document.createElement('div');
      ring.id = 'vex-cursor-ring';
      const dot = document.createElement('div');
      dot.id = 'vex-cursor-dot';
      const tag = document.createElement('div');
      tag.id = 'vex-cursor-tag';
      tag.textContent = '⚡ VEX-AI';

      cursorWrap.appendChild(ring);
      cursorWrap.appendChild(dot);
      cursorWrap.appendChild(tag);
      document.body.appendChild(cursorWrap);
    }

    document.querySelectorAll('.vex-badge').forEach((b) => b.remove());

    const selectors = [
      'input',
      'textarea',
      'button',
      'a',
      '[role="button"]',
      'ytd-subscribe-button-renderer button',
      'yt-button-shape button',
      'ytd-video-renderer a#video-title',
      'ytd-channel-renderer a#main-link'
    ].join(', ');

    const rawNodes = Array.from(document.querySelectorAll(selectors));
    const items = [];
    let idCounter = 1;

    for (const el of rawNodes) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 18 || rect.height < 14) continue;
      if (rect.bottom < 8 || rect.top > window.innerHeight - 8) continue;
      if (rect.right < 8 || rect.left > window.innerWidth - 8) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || '';
      let text = (
        el.innerText ||
        el.value ||
        el.getAttribute('placeholder') ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 70);

      if (!text && tag !== 'input' && tag !== 'textarea') continue;

      const id = idCounter++;
      el.setAttribute('data-vex-id', String(id));
      const alreadyClicked = el.getAttribute('data-vex-clicked') === 'true';

      const badge = document.createElement('div');
      badge.className = alreadyClicked ? 'vex-badge clicked' : 'vex-badge';
      badge.textContent = alreadyClicked ? `#${id}✓` : `#${id}`;
      badge.style.left = Math.max(2, Math.min(window.innerWidth - 40, rect.left)) + 'px';
      badge.style.top = Math.max(4, rect.top - 7) + 'px';
      document.body.appendChild(badge);

      const clickedNote = alreadyClicked ? ' [УЖЕ НАЖАТО ✓ - НЕ ПОВТОРЯТЬ]' : '';
      items.push(`[${id}] <${tag}${type ? ' ' + type : ''}> "${text || 'поле ввода'}"${clickedNote}`);

      if (items.length >= 75) break;
    }

    return {
      url: location.href,
      title: document.title,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1700),
      elements: items.join('\n')
    };
  });
}

// Наведение улучшенного курсора + двойная волна клика + пометка элемента как нажатого
async function animateCursorToElement(page, id, actionLabel) {
  const coords = await page.evaluate(
    (targetId, lbl) => {
      const el = document.querySelector(`[data-vex-id="${targetId}"]`);
      if (!el) return null;

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.setAttribute('data-vex-clicked', 'true');
      el.style.outline = '2px solid #ff2a85';

      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      window.__vexX = x;
      window.__vexY = y;

      const wrap = document.getElementById('vex-cursor-wrap');
      const tag = document.getElementById('vex-cursor-tag');
      if (wrap) {
        wrap.style.left = x + 'px';
        wrap.style.top = y + 'px';
      }
      if (tag) tag.textContent = `${lbl} [${x},${y}]`;

      return { x, y };
    },
    id,
    actionLabel
  );

  if (!coords) return null;

  await page.mouse.move(coords.x, coords.y, { steps: 10 }).catch(() => {});
  await sleep(360);

  await page.evaluate((pt) => {
    const wrap = document.getElementById('vex-cursor-wrap');
    if (wrap) {
      wrap.style.transform = 'scale(0.75)';
      setTimeout(() => {
        if (wrap) wrap.style.transform = 'scale(1)';
      }, 160);
    }
    const wave = document.createElement('div');
    wave.className = 'vex-click-wave';
    wave.style.left = pt.x + 'px';
    wave.style.top = pt.y + 'px';
    document.body.appendChild(wave);
    setTimeout(() => wave.remove(), 650);
  }, coords);

  await updateScreenshot();
  return coords;
}

// Мозг агента с защитой от зацикливания
async function askAgentBrain(goal, pageState, historyLog, antiLoopWarning) {
  const systemPrompt = `Ты — VEXCLOUD 3.0 PRO, сверхбыстрый автономный веб-агент.
Ты управляешь реальным браузером Chrome. Отвечай СТРОГО одним JSON-объектом без markdown-обертки:

Доступные действия:
1) {"action": "goto", "url": "https://...", "reason": "Открываю сайт..."}
2) {"action": "click", "id": 12, "reason": "Кликаю по кнопке [12]..."}
3) {"action": "type", "id": 5, "text": "текст поиска", "submit": true, "reason": "Ввожу запрос в поле [5]..."}
4) {"action": "scroll", "direction": "down", "reason": "Прокручиваю страницу вниз для поиска новых элементов..."}
5) {"action": "press", "key": "Escape", "reason": "Закрываю всплывающее окно..."}
6) {"action": "back", "reason": "Возвращаюсь на прошлую страницу..."}
7) {"action": "done", "answer": "Подробный итог выполнения задачи на русском языке", "reason": "Миссия полностью выполнена!"}

ЖЕЛЕЗНЫЕ ПРАВИЛА ПРОТИВ ЗАВИСАНИЙ (НЕ ТУПИТЬ):
- НИКОГДА не кликай повторно на элементы с пометкой [УЖЕ НАЖАТО ✓ - НЕ ПОВТОРЯТЬ]!
- Если на странице все нужные кнопки уже нажаты или нужной кнопки не видно — СРАЗУ делай {"action": "scroll", "direction": "down"}, чтобы подгрузить новые видео/каналы/ссылки!
- На YouTube: если нужно подписаться на несколько каналов, проще всего ввести тему в поиск (type), затем на странице результатов кликать по кнопкам "Подписаться" (Subscribe), а когда видимые кнопки кончились — делать scroll вниз! Если кнопка пишет "Вы подписаны" (Subscribed) — пропускай её!
- Если нажатие на кнопку открыло окно "Войти в аккаунт" (Sign in), а задача требует подписки — напиши об этом или перейди к просмотру/поиску без входа.
- В поле "reason" всегда веди счётчик прогресса (например: "Подписался на 3 из 15 каналов, ищу дальше").`;

  const userPrompt = `ЦЕЛЬ ПОЛЬЗОВАТЕЛЯ: ${goal}

${antiLoopWarning ? `🚨 КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ: ${antiLoopWarning}\n` : ''}
ИСТОРИЯ ТВОИХ ПОСЛЕДНИХ ШАГОВ:
${historyLog.slice(-16).join('\n') || 'Шагов еще не было'}

ТЕКУЩИЙ URL: ${pageState.url}
ЗАГОЛОВОК: ${pageState.title}

ИНТЕРАКТИВНЫЕ ЭЛЕМЕНТЫ НА ЭКРАНЕ ([ID] <тег> "текст"):
${pageState.elements}`;

  const data = await callGroqWithRotation([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]);

  const raw = data.choices?.[0]?.message?.content || '{}';
  const match = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : raw);
}

// ФОНОВЫЙ АГЕНТ (работает даже при закрытой вкладке)
async function runBackgroundAgent(goal, customMaxSteps) {
  state.isRunning = true;
  state.shouldStop = false;
  state.goal = goal;
  state.step = 0;
  state.maxSteps = Math.max(5, Math.min(500, parseInt(customMaxSteps, 10) || config.defaultMaxSteps || 60));
  state.finalAnswer = '';
  state.statusText = 'Запуск фонового ИИ...';
  addLog(`🚀 СТАРТ ЗАДАЧИ (${state.maxSteps} шагов): "${goal}"`);

  try {
    await ensureBrowser();
    const historyLog = [];
    let lastActionSignature = '';
    let repeatCount = 0;

    for (let step = 1; step <= state.maxSteps; step++) {
      if (state.shouldStop) {
        addLog('🛑 Остановлено пользователем.');
        state.statusText = 'Остановлено';
        break;
      }

      state.step = step;
      state.statusText = `Шаг ${step}/${state.maxSteps} (Ключ #${state.activeKeyNum})...`;

      let pageState;
      try {
        pageState = await scanPage(page);
      } catch (e) {
        await sleep(1000);
        pageState = await scanPage(page);
      }
      await updateScreenshot();

      let antiLoopWarning = '';
      if (repeatCount >= 1) {
        antiLoopWarning =
          'Ты повторяешь одно и то же действие! Выбери ДРУГОЙ ID элемента или сделай {"action": "scroll", "direction": "down"}!';
      }

      const decision = await askAgentBrain(goal, pageState, historyLog, antiLoopWarning);

      // Проверка на зацикливание (если ИИ пытается 2 раза подряд сделать то же самое)
      const currentSig = `${decision.action}_${decision.id || ''}_${decision.text || ''}_${decision.url || ''}`;
      if (currentSig === lastActionSignature && decision.action !== 'scroll') {
        repeatCount++;
        if (repeatCount >= 2) {
          addLog(`⚠️ Анти-зависание: принудительная прокрутка экрана вниз для обновления элементов...`);
          await page.evaluate(() => window.scrollBy({ top: 750, behavior: 'smooth' }));
          await sleep(1000);
          historyLog.push(`Шаг ${step}: [Авто-прокрутка вниз против зацикливания]`);
          repeatCount = 0;
          continue;
        }
      } else {
        lastActionSignature = currentSig;
        repeatCount = 0;
      }

      state.statusText = `[Шаг ${step}/${state.maxSteps}] ${decision.reason || decision.action}`;
      addLog(`⚡ [Шаг ${step} | Ключ #${state.activeKeyNum}] ${decision.reason || decision.action}`);

      if (decision.action === 'done') {
        state.finalAnswer = decision.answer || 'Задача выполнена!';
        state.statusText = '✔ Выполнено!';
        addLog(`✅ ГОТОВО: ${state.finalAnswer}`);
        break;
      }

      try {
        if (decision.action === 'goto' && decision.url) {
          await page.goto(decision.url, { waitUntil: 'domcontentloaded', timeout: 22000 });
          await sleep(1300);
          historyLog.push(`Шаг ${step}: Открыл ${decision.url}`);
        } else if (decision.action === 'click' && decision.id) {
          const coords = await animateCursorToElement(page, decision.id, `CLICK #${decision.id}`);
          const el = await page.$(`[data-vex-id="${decision.id}"]`);
          if (el) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3800 }).catch(() => {}),
              el.click().catch(async () => {
                if (coords) await page.mouse.click(coords.x, coords.y);
              })
            ]);
          }
          await sleep(1200);
          historyLog.push(`Шаг ${step}: Нажал [#${decision.id}] (${decision.reason})`);
        } else if (decision.action === 'type' && decision.id) {
          await animateCursorToElement(page, decision.id, `TYPE "${(decision.text || '').slice(0, 12)}"`);
          const el = await page.$(`[data-vex-id="${decision.id}"]`);
          if (el) {
            await el.click({ clickCount: 3 }).catch(() => {});
            await page.keyboard.press('Backspace').catch(() => {});
            await el.type(decision.text || '', { delay: 25 });
            if (decision.submit !== false) {
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
                page.keyboard.press('Enter')
              ]);
            }
          }
          await sleep(1600);
          historyLog.push(`Шаг ${step}: Ввел "${decision.text}" в [#${decision.id}]`);
        } else if (decision.action === 'scroll') {
          const dir = decision.direction || 'down';
          await page.evaluate((d) => {
            window.scrollBy({ top: d === 'up' ? -750 : 750, behavior: 'smooth' });
          }, dir);
          await sleep(1100);
          historyLog.push(`Шаг ${step}: Прокрутил экран (${dir})`);
        } else if (decision.action === 'press' && decision.key) {
          await page.keyboard.press(decision.key);
          await sleep(900);
          historyLog.push(`Шаг ${step}: Нажал клавишу ${decision.key}`);
        } else if (decision.action === 'back') {
          await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(1100);
          historyLog.push(`Шаг ${step}: Вернулся назад`);
        }
      } catch (stepErr) {
        addLog(`⚠ Сбой действия на шаге ${step}: ${stepErr.message}`);
        historyLog.push(`Шаг ${step}: Действие не удалось, пробую другой элемент`);
      }

      await updateScreenshot();
    }
  } catch (err) {
    addLog(`✖ Критическая ошибка: ${err.message}`);
    state.statusText = `Ошибка: ${err.message}`;
  } finally {
    state.isRunning = false;
    await updateScreenshot();
  }
}

// ВЕБ-ПАНЕЛЬ УПРАВЛЕНИЯ (Улучшенный Киберпанк-дизайн)
const HTML_DASHBOARD = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VEXCLOUD 3.0 PRO — Autonomous AI Browser</title>
<style>
  :root {
    --bg: #050509;
    --card: #0d0d16;
    --card-2: #131320;
    --border: #232338;
    --cyan: #00f0ff;
    --green: #00ff9d;
    --magenta: #ff2a85;
    --yellow: #ffde00;
    --text: #ececf6;
    --muted: #7c7c98;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
    padding: 18px;
    background-image: radial-gradient(rgba(0, 240, 255, 0.06) 1px, transparent 1px);
    background-size: 24px 24px;
  }
  .topbar {
    display: flex; justify-content: space-between; align-items: center;
    background: var(--card); border: 1px solid var(--border);
    padding: 14px 20px; border-radius: 8px; margin-bottom: 16px;
    flex-wrap: wrap; gap: 12px;
  }
  .brand {
    display: flex; align-items: center; gap: 12px;
  }
  .brand-title {
    font-size: 1.15rem; font-weight: bold; color: var(--cyan);
    text-shadow: 0 0 12px rgba(0,240,255,0.4);
  }
  .pills { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .pill {
    font-size: 0.78rem; padding: 5px 11px; border-radius: 5px;
    background: var(--card-2); border: 1px solid var(--border);
  }
  .pill.key-pill { border-color: var(--cyan); color: var(--cyan); }
  .pill.status-pill { border-color: var(--green); color: var(--green); font-weight: bold; }
  .pill.status-pill.busy {
    border-color: var(--magenta); color: var(--magenta);
    box-shadow: 0 0 12px rgba(255,42,133,0.35);
  }

  /* Панель запуска и выбора шагов */
  .launcher {
    background: var(--card); border: 1px solid var(--border);
    padding: 16px; border-radius: 8px; margin-bottom: 16px;
  }
  .launcher-row {
    display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
  }
  .goal-input {
    flex: 1; min-width: 260px; background: #06060b;
    border: 1px solid var(--cyan); color: #fff;
    padding: 13px 15px; border-radius: 6px; font-family: inherit;
    font-size: 0.92rem; outline: none;
  }
  .steps-box {
    display: flex; align-items: center; gap: 8px;
    background: #06060b; border: 1px solid var(--border);
    padding: 8px 12px; border-radius: 6px;
  }
  .steps-box label { font-size: 0.78rem; color: var(--muted); }
  .steps-input {
    width: 68px; background: var(--card-2); border: 1px solid var(--cyan);
    color: var(--cyan); font-weight: bold; padding: 5px 8px;
    font-family: inherit; font-size: 0.9rem; text-align: center; border-radius: 4px;
  }
  .btn {
    border: none; padding: 13px 20px; border-radius: 6px;
    font-family: inherit; font-weight: bold; font-size: 0.88rem;
    cursor: pointer; transition: 0.15s;
  }
  .btn-start { background: var(--cyan); color: #000; }
  .btn-start:hover { box-shadow: 0 0 15px rgba(0,240,255,0.6); }
  .btn-stop { background: var(--magenta); color: #fff; }

  .presets {
    display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; align-items: center;
  }
  .preset-btn {
    background: var(--card-2); border: 1px solid var(--border);
    color: var(--muted); padding: 5px 10px; border-radius: 4px;
    font-family: inherit; font-size: 0.75rem; cursor: pointer;
  }
  .preset-btn:hover { border-color: var(--cyan); color: var(--text); }

  /* Прогресс-бар шагов */
  .progress-wrap {
    margin-top: 12px; background: #06060b; height: 8px;
    border-radius: 4px; overflow: hidden; border: 1px solid var(--border);
  }
  .progress-fill {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, var(--cyan), var(--magenta));
    transition: width 0.3s ease;
  }

  /* Основная сетка */
  .main-grid {
    display: grid; grid-template-columns: 1.85fr 1.15fr; gap: 16px;
  }
  @media (max-width: 980px) { .main-grid { grid-template-columns: 1fr; } }

  .panel {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 8px; padding: 14px;
  }

  /* Адресная строка и управление экраном */
  .browser-toolbar {
    display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; align-items: center;
  }
  .url-bar {
    flex: 1; background: #06060b; border: 1px solid var(--border);
    color: var(--green); padding: 7px 11px; border-radius: 4px;
    font-family: inherit; font-size: 0.8rem;
  }
  .tool-btn {
    background: var(--card-2); border: 1px solid var(--border);
    color: var(--text); padding: 7px 11px; border-radius: 4px;
    font-family: inherit; font-size: 0.78rem; cursor: pointer;
  }
  .tool-btn:hover { border-color: var(--cyan); color: var(--cyan); }

  .screen-container {
    position: relative; width: 100%; aspect-ratio: 16 / 10;
    background: #000; border: 1px solid var(--border);
    border-radius: 6px; overflow: hidden; cursor: crosshair;
  }
  #live-img { width: 100%; height: 100%; object-fit: contain; display: block; }

  /* Правая колонка с вкладками */
  .tabs {
    display: flex; border-bottom: 1px solid var(--border); margin-bottom: 12px;
  }
  .tab-btn {
    flex: 1; background: transparent; border: none; color: var(--muted);
    padding: 10px; font-family: inherit; font-size: 0.84rem;
    cursor: pointer; border-bottom: 2px solid transparent;
  }
  .tab-btn.active {
    color: var(--cyan); border-bottom-color: var(--cyan); font-weight: bold;
  }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .logs-box {
    height: 390px; overflow-y: auto; background: #06060b;
    border: 1px solid var(--border); border-radius: 6px;
    padding: 12px; font-size: 0.79rem; line-height: 1.55;
    color: var(--green); white-space: pre-wrap;
  }
  .answer-card {
    margin-top: 10px; padding: 12px; border-radius: 6px;
    background: rgba(255, 42, 133, 0.08); border: 1px solid var(--magenta);
    font-size: 0.84rem; display: none;
  }

  /* Вкладка управления API ключами */
  .keys-textarea {
    width: 100%; height: 150px; background: #06060b;
    border: 1px solid var(--cyan); color: var(--text);
    padding: 10px; border-radius: 6px; font-family: inherit;
    font-size: 0.8rem; resize: vertical; margin: 8px 0 10px;
  }
  .key-list {
    margin-top: 12px; display: flex; flex-direction: column; gap: 6px;
    max-height: 200px; overflow-y: auto;
  }
  .key-item {
    display: flex; justify-content: space-between; align-items: center;
    background: #06060b; border: 1px solid var(--border);
    padding: 8px 12px; border-radius: 5px; font-size: 0.78rem;
  }
  .key-item.active-key { border-color: var(--green); }
</style>
</head>
<body>

<div class="topbar">
  <div class="brand">
    <span class="brand-title">⚡ VEXCLOUD 3.0 PRO</span>
    <span style="font-size:0.78rem;color:var(--muted)">24/7 Фоновый ИИ-Браузер с Ротацией Ключей</span>
  </div>
  <div class="pills">
    <div class="pill key-pill" id="key-badge">🔑 Активен Ключ #1 (Переключений: 0)</div>
    <div class="pill" id="step-badge" style="color:var(--yellow)">Шаги: 0 / 60</div>
    <div class="pill status-pill" id="status-badge">ГОТОВ</div>
  </div>
</div>

<div class="launcher">
  <div class="launcher-row">
    <input id="goal-input" class="goal-input" placeholder="Введи задачу: например, зайди на YouTube, найди 15 каналов по теме ИИ и подпишись на каждый..." />
    <div class="steps-box">
      <label>ШАГОВ:</label>
      <input id="steps-input" type="number" min="5" max="500" value="60" class="steps-input" />
    </div>
    <button class="btn btn-start" onclick="startTask()">🚀 ЗАПУСТИТЬ В ФОНЕ</button>
    <button class="btn btn-stop" onclick="stopTask()">🛑 СТОП</button>
  </div>

  <div class="presets">
    <span style="font-size:0.75rem;color:var(--muted)">Быстрые шаблоны:</span>
    <button class="preset-btn" onclick="setPreset('Зайди на youtube.com, введи в поиск Python уроки и подпишись на 15 разных каналов (прокручивай вниз, когда кнопки кончаются)', 80)">📺 15 подписок на YouTube (80 шагов)</button>
    <button class="preset-btn" onclick="setPreset('Зайди на github.com/trending, пролистай страницу и собери топ-10 популярных репозиториев с описанием', 30)">🔥 Топ-10 GitHub Trending (30 шагов)</button>
    <button class="preset-btn" onclick="setPreset('Открой wikipedia.org, найди статью про Искусственный интеллект и выпиши 5 ключевых дат', 25)">🌐 Исследование Википедии (25 шагов)</button>
    <button class="preset-btn" onclick="addSteps(50)">➕ +50 шагов</button>
  </div>

  <div class="progress-wrap">
    <div id="progress-fill" class="progress-fill"></div>
  </div>
</div>

<div class="main-grid">
  <!-- Левая панель: прямая трансляция и ручное управление -->
  <div class="panel">
    <div class="browser-toolbar">
      <input id="url-input" class="url-bar" value="https://www.youtube.com" />
      <button class="tool-btn" onclick="manualGoto()">Перейти</button>
      <button class="tool-btn" onclick="manualScroll('up')">⬆ Вверх</button>
      <button class="tool-btn" onclick="manualScroll('down')">⬇ Вниз</button>
      <button class="tool-btn" onclick="manualKey('Escape')">Esc</button>
    </div>

    <div class="screen-container" onclick="remoteClick(event)" title="Кликни в любое место экрана, чтобы нажать кнопку вручную">
      <img id="live-img" alt="Загрузка экрана Chrome..." />
    </div>

    <div class="browser-toolbar" style="margin-top:10px;margin-bottom:0;">
      <input id="manual-text" class="url-bar" style="color:#fff" placeholder="Ручной ввод текста (например, логин/пароль для входа в аккаунт YouTube)..." />
      <button class="tool-btn" style="border-color:var(--cyan);color:var(--cyan)" onclick="remoteType()">⌨️ Напечатать + Enter</button>
    </div>
  </div>

  <!-- Правая панель: Логи и Ротация API-ключей -->
  <div class="panel">
    <div class="tabs">
      <button class="tab-btn active" id="btn-tab-logs" onclick="openTab('logs')">📜 Лог работы (Live)</button>
      <button class="tab-btn" id="btn-tab-keys" onclick="openTab('keys')">🔑 API Ключи и Лимиты</button>
    </div>

    <!-- Вкладка 1: Логи -->
    <div class="tab-content active" id="tab-logs">
      <div id="logs-box" class="logs-box"></div>
      <div id="answer-card" class="answer-card"></div>
    </div>

    <!-- Вкладка 2: Настройка нескольких API ключей -->
    <div class="tab-content" id="tab-keys">
      <div style="font-size:0.8rem;color:var(--muted);line-height:1.4;">
        Вставь сюда <strong>несколько API-ключей Groq</strong> (каждый ключ с новой строки). Если на первом ключе закончится лимит (429), сервер мгновенно переключится на второй и продолжит задачу без остановки!
      </div>

      <textarea id="keys-textarea" class="keys-textarea" placeholder="gsk_ключ_1...\ngsk_ключ_2...\ngsk_ключ_3..."></textarea>

      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">
        <span style="font-size:0.8rem;color:var(--muted)">Модель ИИ:</span>
        <select id="model-select" class="url-bar" style="color:var(--cyan)">
          <option value="openai/gpt-oss-120b">openai/gpt-oss-120b (500 т/с — Основная)</option>
          <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile (Резервная)</option>
          <option value="llama-3.1-8b-instant">llama-3.1-8b-instant (Максимальный лимит токенов)</option>
        </select>
      </div>

      <button class="btn btn-start" style="width:100%;padding:10px;" onclick="saveApiKeys()">💾 СОХРАНИТЬ ПУЛ КЛЮЧЕЙ</button>

      <div style="font-size:0.78rem;color:var(--muted);margin-top:14px;">Статус подключенных ключей:</div>
      <div id="key-list" class="key-list"></div>
    </div>
  </div>
</div>

<script>
  function openTab(tab) {
    document.getElementById('tab-logs').classList.toggle('active', tab === 'logs');
    document.getElementById('tab-keys').classList.toggle('active', tab === 'keys');
    document.getElementById('btn-tab-logs').classList.toggle('active', tab === 'logs');
    document.getElementById('btn-tab-keys').classList.toggle('active', tab === 'keys');
    if (tab === 'keys') loadKeysConfig();
  }

  function setPreset(text, steps) {
    document.getElementById('goal-input').value = text;
    document.getElementById('steps-input').value = steps;
  }

  function addSteps(n) {
    const el = document.getElementById('steps-input');
    el.value = Math.min(500, (parseInt(el.value, 10) || 60) + n);
  }

  async function startTask() {
    const goal = document.getElementById('goal-input').value.trim();
    const maxSteps = parseInt(document.getElementById('steps-input').value, 10) || 60;
    if (!goal) return alert('Введи задачу для ИИ-браузера!');
    await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, maxSteps })
    });
    pollStatus();
  }

  async function stopTask() {
    await fetch('/api/stop', { method: 'POST' });
  }

  async function manualGoto() {
    const url = document.getElementById('url-input').value.trim();
    if (!url) return;
    await fetch('/api/goto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
  }

  async function manualScroll(direction) {
    await fetch('/api/scroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction })
    });
  }

  async function manualKey(key) {
    await fetch('/api/press', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
  }

  async function remoteClick(e) {
    const img = document.getElementById('live-img');
    const rect = img.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1280);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 800);
    await fetch('/api/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y })
    });
  }

  async function remoteType() {
    const input = document.getElementById('manual-text');
    const text = input.value;
    if (!text) return;
    input.value = '';
    await fetch('/api/type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  }

  async function loadKeysConfig() {
    const res = await fetch('/api/config');
    const data = await res.json();
    document.getElementById('keys-textarea').value = (data.apiKeys || []).join('\\n');
    document.getElementById('model-select').value = data.model || 'openai/gpt-oss-120b';
    renderKeyStats(data.stats || [], data.activeKeyIndex || 0);
  }

  async function saveApiKeys() {
    const raw = document.getElementById('keys-textarea').value;
    const apiKeys = raw.split('\\n').map(k => k.trim()).filter(Boolean);
    const model = document.getElementById('model-select').value;
    if (apiKeys.length === 0) return alert('Добавь хотя бы 1 API-ключ!');

    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKeys, model })
    });
    const data = await res.json();
    renderKeyStats(data.stats || [], data.activeKeyIndex || 0);
    alert('✔ Сохранено ключей в пуле: ' + apiKeys.length);
  }

  function renderKeyStats(stats, activeIdx) {
    const container = document.getElementById('key-list');
    container.textContent = '';
    stats.forEach((st, i) => {
      const row = document.createElement('div');
      row.className = 'key-item' + (i === activeIdx ? ' active-key' : '');
      const left = document.createElement('span');
      left.textContent = 'Ключ #' + st.index + ' (' + st.masked + ')' + (i === activeIdx ? ' [ТЕКУЩИЙ]' : '');
      const right = document.createElement('span');
      right.style.color = st.status.includes('LIMIT') ? 'var(--magenta)' : 'var(--green)';
      right.textContent = st.status + ' | Запросов: ' + st.calls;
      row.appendChild(left);
      row.appendChild(right);
      container.appendChild(row);
    });
  }

  async function pollStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();

      const stBadge = document.getElementById('status-badge');
      stBadge.textContent = data.statusText;
      stBadge.className = data.isRunning ? 'pill status-pill busy' : 'pill status-pill';

      document.getElementById('step-badge').textContent = 'Шаги: ' + data.step + ' / ' + data.maxSteps;
      document.getElementById('key-badge').textContent =
        '🔑 Ключ #' + data.activeKeyNum + '/' + data.totalKeys + ' (Ротаций: ' + data.rotationsCount + ')';

      const pct = data.maxSteps > 0 ? Math.min(100, Math.round((data.step / data.maxSteps) * 100)) : 0;
      document.getElementById('progress-fill').style.width = pct + '%';

      if (data.lastScreenshot) {
        document.getElementById('live-img').src = data.lastScreenshot;
      }

      if (document.activeElement !== document.getElementById('url-input') && data.currentUrl) {
        document.getElementById('url-input').value = data.currentUrl;
      }

      const logsEl = document.getElementById('logs-box');
      logsEl.textContent = data.logs.join('\\n');
      logsEl.scrollTop = logsEl.scrollHeight;

      const ansEl = document.getElementById('answer-card');
      if (data.finalAnswer) {
        ansEl.style.display = 'block';
        ansEl.textContent = '✅ ОТЧЕТ АГЕНТА: ' + data.finalAnswer;
      } else {
        ansEl.style.display = 'none';
      }
    } catch (e) {}
  }

  setInterval(pollStatus, 1000);
  pollStatus();
  loadKeysConfig();
</script>
</body>
</html>`;

// HTTP Сервер
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML_DASHBOARD);
  }

  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state));
  }

  if (req.method === 'GET' && req.url === '/api/config') {
    syncKeyStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        apiKeys: config.apiKeys,
        model: config.model,
        activeKeyIndex,
        stats: Object.values(keyStats)
      })
    );
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    try {
      const data = body ? JSON.parse(body) : {};

      if (req.method === 'POST' && req.url === '/api/config') {
        if (Array.isArray(data.apiKeys) && data.apiKeys.length > 0) {
          config.apiKeys = data.apiKeys;
        }
        if (data.model) config.model = data.model;
        saveConfig();
        syncKeyStats();
        addLog(`🔑 Обновлен пул API-ключей! Всего ключей в ротации: ${config.apiKeys.length}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            ok: true,
            activeKeyIndex,
            stats: Object.values(keyStats)
          })
        );
      }

      if (req.method === 'POST' && req.url === '/api/start') {
        if (!state.isRunning && data.goal) {
          runBackgroundAgent(data.goal, data.maxSteps);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (req.method === 'POST' && req.url === '/api/stop') {
        state.shouldStop = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (req.method === 'POST' && req.url === '/api/goto') {
        await ensureBrowser();
        let target = data.url || '';
        if (!target.startsWith('http')) target = 'https://' + target;
        await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await updateScreenshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (req.method === 'POST' && req.url === '/api/scroll') {
        await ensureBrowser();
        await page.evaluate((d) => {
          window.scrollBy({ top: d === 'up' ? -650 : 650, behavior: 'smooth' });
        }, data.direction || 'down');
        await sleep(400);
        await updateScreenshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (req.method === 'POST' && req.url === '/api/press') {
        await ensureBrowser();
        await page.keyboard.press(data.key || 'Escape');
        await sleep(300);
        await updateScreenshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (req.method === 'POST' && req.url === '/api/click') {
        await ensureBrowser();
        await page.mouse.click(data.x || 640, data.y || 400);
        await sleep(350);
        await updateScreenshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (req.method === 'POST' && req.url === '/api/type') {
        await ensureBrowser();
        await page.keyboard.type(data.text || '', { delay: 25 });
        await page.keyboard.press('Enter');
        await sleep(450);
        await updateScreenshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      res.writeHead(404);
      res.end();
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n⚡ VEXCLOUD 3.0 PRO запущен! Открой в браузере: http://localhost:${PORT}\n`);
  ensureBrowser().catch(() => {});
});
