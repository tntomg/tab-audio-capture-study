// test_save_meta.js — проверяет выбор автора/названия при сохранении:
//   autoTitle=true  -> данные страницы перекрывают ввод popup (и сохранённый ручной);
//   autoTitle=false -> ввод popup (или сохранённый manualMeta для автосейва)
//                      перекрывает данные страницы;
//   снимок со старта записи НЕ теряется, если к моменту сохранения страница
//   уехала на следующий трек (Suno) или content script стал недоступен.
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

// что content script отдаёт на get-meta — меняется по ходу теста
let contentMeta = {
  site: 'Suno', artist: 'Page Artist', title: 'Page Song', parsed: true, uuid: 'song-page',
};
let contentGone = false;

global.chrome = {
  runtime: {
    onMessage: mkEvent('runtime.onMessage'),
    lastError: null,
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
      if (contentGone) {
        chrome.runtime.lastError = { message: 'Could not establish connection' };
        cb();
        chrome.runtime.lastError = null;
        return;
      }
      if (msg && msg.type === 'get-meta') cb({ ok: true, meta: contentMeta });
      else if (msg && msg.type === 'get-cover') cb({ ok: true, b64: '' });
      else if (msg && msg.type === 'recording-started') cb({ ok: true, meta: contentMeta });
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

  // 5. Снимок на старте записи; страница уехала на следующий трек
  contentMeta = { site: 'Suno', artist: 'Real Artist', title: 'Real Song', parsed: true, uuid: 'song-real' };
  let r = await route({ type: 'start', mode: 'current', tabId: 1 });
  check('start: запись началась', r && r.ok, true);
  check('start: снимок в storage', sessionStore.rec.trackMeta &&
    sessionStore.rec.trackMeta.title, 'Real Song');
  contentMeta = { site: 'Suno', artist: 'Next Artist', title: 'Next Song', parsed: true, uuid: 'song-next' };
  await route({ type: 'stop' });
  await route({ type: 'save', meta: null, format: 'mp3' });
  m = lastSave();
  check('next track: artist со старта', m && m.meta && m.meta.artist, 'Real Artist');
  check('next track: title со старта', m && m.meta && m.meta.title, 'Real Song');

  // 6. К моменту сохранения content script недоступен — снимок всё равно есть
  contentGone = true;
  await route({ type: 'save', meta: null, format: 'mp3' });
  m = lastSave();
  check('content gone: artist со старта', m && m.meta && m.meta.artist, 'Real Artist');
  check('content gone: title со старта', m && m.meta && m.meta.title, 'Real Song');
  contentGone = false;

  console.log(failed ? 'SAVE META FAIL: ' + failed : 'SAVE META OK');
  process.exit(failed ? 1 : 0);
})();
