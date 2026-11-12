// smoke_test_sw.js — проверяет, что топ-левел background.js не бросает
// исключений (причина «Service worker registration failed. Status code: 15»).
// Запускаем файл с заглушкой chrome API: если оценка проходит — SW стартанёт.
const fs = require('fs');
const path = require('path');

const listeners = {};
const mkEvent = (name) => ({
  addListener(fn) { listeners[name] = fn; },
  removeListener() {},
});

let contentRestart = { ok: true };
let streamCalls = 0;

const chromeStub = {
  runtime: {
    onMessage: mkEvent('runtime.onMessage'),
    getContexts: async () => [],
    sendMessage: (msg, cb) => { if (cb) cb({ ok: true, stub: true }); },
  },
  offscreen: { createDocument: async () => {} },
  tabCapture: {
    onStatusChanged: mkEvent('tabCapture.onStatusChanged'),
    getMediaStreamId: async () => { streamCalls++; return 'stub-stream-id'; },
  },
  downloads: {
    onChanged: mkEvent('downloads.onChanged'),
    download: async () => 1,
  },
  tabs: {
    onRemoved: mkEvent('tabs.onRemoved'),
    sendMessage: (id, msg, cb) => {
      if (msg && msg.type === 'prepare-restart') cb(contentRestart);
      else cb({ ok: true });
    },
    query: async () => [{ id: 1 }],
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
  },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
};

global.chrome = chromeStub;

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
try {
  // eslint-disable-next-line no-new-func
  new Function(src)();
  console.log('SMOKE OK: топ-левел background.js выполнился без исключений');
  console.log('зарегистрировано слушателей:', Object.keys(listeners).join(', '));
  // минимальный вызов роутера сообщений (асинхронная ветка)
  const router = listeners['runtime.onMessage'];
  if (typeof router === 'function') {
    const route = (msg) => new Promise((resolve) => router(msg, {}, resolve));

    (async () => {
      let r = await route({ type: 'unknown-xyz' });
      console.log('router отвечает на мусор:', JSON.stringify(r));

      // полный цикл старта записи «с начала» (content script на связи)
      contentRestart = { ok: true };
      streamCalls = 0;
      r = await route({ type: 'start', mode: 'restart', tabId: 42 });
      console.log('router start/restart:', JSON.stringify(r));
      if (!r || r.ok !== true) { console.error('SMOKE FAIL: start не прошёл'); process.exit(1); }
      if (streamCalls !== 1) { console.error('SMOKE FAIL: getMediaStreamId не вызван'); process.exit(1); }

      console.log('router stop:', JSON.stringify(await route({ type: 'stop' })));
      console.log('router save:', JSON.stringify(
        await route({ type: 'save', meta: { artist: 'a', title: 'b' }, format: 'mp3' })));

      // вкладка открыта до обновления расширения: content script мёртв →
      // restart должен отказать ДО запуска захвата
      contentRestart = { ok: false, error: 'no-content' };
      streamCalls = 0;
      r = await route({ type: 'start', mode: 'restart', tabId: 42 });
      console.log('router start/restart (no-content):', JSON.stringify(r));
      if (!r || r.ok !== false || r.error !== 'content-missing') {
        console.error('SMOKE FAIL: restart без content script не отвергнут'); process.exit(1);
      }
      if (streamCalls !== 0) {
        console.error('SMOKE FAIL: захват стартовал без content script'); process.exit(1);
      }
      console.log('SMOKE OK: restart-режим и отказ без content script работают');
    })().catch((e) => {
      console.error('SMOKE FAIL:', e && e.stack);
      process.exit(1);
    });
  }
} catch (e) {
  console.error('SMOKE FAIL:', e && e.stack);
  process.exit(1);
}
