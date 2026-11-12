// test_save_meta.js — проверяет выбор автора/названия при сохранении:
//   autoTitle=true  -> данные страницы перекрывают ввод popup (и сохранённый ручной);
//   autoTitle=false -> ввод popup (или сохранённый manualMeta для автосейва)
//                      перекрывает данные страницы.
// background.js загружается через new Function с заглушкой chrome API,
// поэтому тест не требует ни сети, ни реального расширения.
const fs = require('fs');
const path = require('path');

const listeners = {};
const mkEvent = (name) => ({
  addListener(fn) { listeners[name] = fn; },
  removeListener() {},
});

const localStore = {};
const sessionStore = { rec: { tabId: 1 } };
const offscreenMsgs = [];

const PAGE_META = { site: 'Suno', artist: 'Page Artist', title: 'Page Song', image: null };

global.chrome = {
  runtime: {
    onMessage: mkEvent('runtime.onMessage'),
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
    sendMessage: (msg, cb) => {
      if (msg && msg.target === 'offscreen') offscreenMsgs.push(msg);
      if (cb) cb({ ok: true });
    },
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
    sendMessage: (id, msg, cb) => {
      if (msg && msg.type === 'get-meta') cb({ ok: true, meta: PAGE_META });
      else if (msg && msg.type === 'get-cover') cb({ ok: true, b64: '' });
      else cb({ ok: true });
    },
    query: async () => [{ id: 1 }],
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
  },
  storage: {
    session: {
      get: async () => sessionStore,
      set: async (patch) => Object.assign(sessionStore, patch),
    },
    local: {
      get: async () => localStore,
      set: async (patch) => Object.assign(localStore, patch),
    },
  },
};

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
new Function(src)();

const router = listeners['runtime.onMessage'];
let failed = 0;

function route(msg) {
  return new Promise((resolve) => router(msg, {}, resolve));
}

function lastSave() {
  return offscreenMsgs.filter((m) => m.type === 'save').pop();
}

function check(name, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name +
    ' -> ' + JSON.stringify(actual) + (ok ? '' : ' (ожидалось ' + JSON.stringify(expected) + ')'));
  if (!ok) failed++;
}

(async () => {
  // 1. Авто по умолчанию: страница перекрывает значения из popup
  await route({ type: 'save', meta: { artist: 'Manual', title: 'Manual Title' }, format: 'mp3' });
  let m = lastSave();
  check('auto: artist со страницы', m && m.meta && m.meta.artist, 'Page Artist');
  check('auto: title со страницы', m && m.meta && m.meta.title, 'Page Song');

  // 2. Ручной режим: ввод popup перекрывает страницу
  localStore.autoTitle = false;
  await route({ type: 'save', meta: { artist: 'Manual', title: 'Manual Title' }, format: 'mp3' });
  m = lastSave();
  check('manual: artist из popup', m && m.meta && m.meta.artist, 'Manual');
  check('manual: title из popup', m && m.meta && m.meta.title, 'Manual Title');

  // 3. Автосейв при закрытом popup: сохранённый manualMeta вместо opts.meta
  await route({ type: 'setManualMeta', meta: { artist: 'Stored', title: 'Stored Title' } });
  await route({ type: 'save', meta: null, format: 'mp3' });
  m = lastSave();
  check('manual+autosave: artist из storage', m && m.meta && m.meta.artist, 'Stored');
  check('manual+autosave: title из storage', m && m.meta && m.meta.title, 'Stored Title');

  // 4. Авто-режим игнорирует сохранённые ручные значения
  localStore.autoTitle = true;
  await route({ type: 'save', meta: null, format: 'mp3' });
  m = lastSave();
  check('auto+autosave: artist со страницы', m && m.meta && m.meta.artist, 'Page Artist');
  check('auto+autosave: title со страницы', m && m.meta && m.meta.title, 'Page Song');

  console.log(failed ? 'SAVE META FAIL: ' + failed : 'SAVE META OK');
  process.exit(failed ? 1 : 0);
})();
