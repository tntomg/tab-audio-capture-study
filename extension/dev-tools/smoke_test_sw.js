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

const chromeStub = {
  runtime: {
    onMessage: mkEvent('runtime.onMessage'),
    getContexts: async () => [],
    sendMessage: (msg, cb) => { if (cb) cb({ ok: true, stub: true }); },
  },
  offscreen: { createDocument: async () => {} },
  tabCapture: {
    onStatusChanged: mkEvent('tabCapture.onStatusChanged'),
    getMediaStreamId: async () => 'stub-stream-id',
  },
  downloads: {
    onChanged: mkEvent('downloads.onChanged'),
    download: async () => 1,
  },
  tabs: {
    onRemoved: mkEvent('tabs.onRemoved'),
    sendMessage: (id, msg, cb) => { if (cb) cb({ ok: true }); },
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
    router({ type: 'unknown-xyz' }, {}, (resp) => {
      console.log('router отвечает на мусор:', JSON.stringify(resp));
    });
    // полный цикл старта записи «с начала» (все ответы — заглушки ok:true)
    router({ type: 'start', mode: 'restart', tabId: 42 }, {}, (resp) => {
      console.log('router start/restart:', JSON.stringify(resp));
      if (!resp || resp.ok !== true) { console.error('SMOKE FAIL: start не прошёл'); process.exit(1); }
      // стоп и сохранение
      router({ type: 'stop' }, {}, (r2) => console.log('router stop:', JSON.stringify(r2)));
      router({ type: 'save', meta: { artist: 'a', title: 'b' }, format: 'mp3' }, {},
        (r3) => console.log('router save:', JSON.stringify(r3)));
    });
  }
} catch (e) {
  console.error('SMOKE FAIL:', e && e.stack);
  process.exit(1);
}
