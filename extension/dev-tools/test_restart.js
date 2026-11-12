// test_restart.js — проверяет режим «Записать песню с начала» в content.js:
//   1) 'ended' во время записи ставит hold (защита от автоперехода Suno)
//      и отправляет быстрый стоп в offscreen;
//   2) prepare-restart перематывает на 0:00 и СБРАСЫВАЕТ hold, иначе
//      следующий play() тут же глушится обработчиком play и трек не стартует;
//   3) play-now реально запускает плеер после перемотки.
// DOM и chrome API — минимальные заглушки, сеть не нужна.
const fs = require('fs');
const path = require('path');

class FakeAudio {
  constructor(id) {
    this.id = id;
    this.listeners = {};
    this.paused = true;
    this.currentTime = 42;
    this.currentSrc = 'blob:https://suno.com/stub';
    this.src = '';
    this.duration = 180;
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn({ type })); }
  pause() {
    const wasPlaying = !this.paused;
    this.paused = true;
    if (wasPlaying) this.dispatch('pause');
  }
  play() {
    this.paused = false;
    this.dispatch('play');
    return Promise.resolve();
  }
}

const audio = new FakeAudio('active-audio-play');
const listeners = {};
const offscreenMsgs = [];
const swMsgs = [];

global.window = {};
global.location = {
  hostname: 'suno.com',
  href: 'https://suno.com/song/0ee28dcc-929d-410b-a60c-6f5076b46f15',
  pathname: '/song/0ee28dcc-929d-410b-a60c-6f5076b46f15',
};
global.document = {
  title: 'Page Song by Page Artist | Suno',
  documentElement: {},
  querySelectorAll: (sel) => (sel === 'audio' ? [audio] : []),
  getElementById: (id) => (id === 'active-audio-play' ? audio : null),
  querySelector: () => null,
};
global.MutationObserver = class {
  constructor(fn) { this.fn = fn; }
  observe() {}
};
// Media Session: платформа выставляет «что играет сейчас» для системных
// медиа-контролов; content.js должен предпочитать его SSR/document.title.
// В Node navigator — геттер только для чтения, поэтому обычное присваивание
// молча игнорируется в sloppy-режиме: переопределяем свойство явно.
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaSession: {
      metadata: {
        title: 'Session Song',
        artist: 'Session Artist',
        artwork: [{ src: 'https://cdn.example/cover.png' }],
      },
    },
  },
  configurable: true,
  writable: true,
});
global.chrome = {
  runtime: {
    onMessage: { addListener(fn) { listeners.msg = fn; } },
    lastError: null,
    sendMessage: (msg, cb) => {
      (msg && msg.target === 'offscreen' ? offscreenMsgs : swMsgs).push(msg);
      if (cb) cb({ ok: true, noop: true });
    },
  },
};

const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
new Function(src)();

const route = (msg) => new Promise((resolve) => listeners.msg(msg, {}, resolve));
let failed = 0;

function check(name, ok, detail) {
  console.log((ok ? 'OK' : 'FAIL') + ': ' + name + (detail ? ' -> ' + detail : ''));
  if (!ok) failed++;
}

(async () => {
  // до записи: Media Session главнее document.title (SSR-скриптов в заглушке нет)
  const before = await route({ type: 'get-meta' });
  check('get-meta: название из Media Session',
    before && before.meta && before.meta.title === 'Session Song',
    before && before.meta && before.meta.title);
  check('get-meta: исполнитель из Media Session',
    before && before.meta && before.meta.artist === 'Session Artist',
    before && before.meta && before.meta.artist);

  // запись идёт; песня заканчивается → быстрый стоп + hold
  await route({ type: 'recording-started' });

  // Suno успела перевести очередь на следующий трек — снимок со старта
  // записи важнее «что показывает страница сейчас»
  global.navigator.mediaSession.metadata = {
    title: 'Next Song', artist: 'Next Artist', artwork: [],
  };
  const during = await route({ type: 'get-meta' });
  check('get-meta во время записи: название со старта',
    during && during.meta && during.meta.title === 'Session Song',
    during && during.meta && during.meta.title);

  audio.dispatch('ended');
  check('ended: быстрый стоп в offscreen',
    offscreenMsgs.some((m) => m.type === 'stop-recording'));
  check('ended: событие в service worker',
    swMsgs.some((m) => m.type === 'playback-ended'));
  const endedMsg = swMsgs.filter((m) => m.type === 'playback-ended').pop();
  check('ended: снимок метаданных в событии',
    endedMsg && endedMsg.meta && endedMsg.meta.title === 'Session Song',
    endedMsg && endedMsg.meta && endedMsg.meta.title);

  // пользователь сразу жмёт «с начала» — hold не должен помешать
  const prep = await route({ type: 'prepare-restart' });
  check('prepare-restart: ok', prep && prep.ok === true, JSON.stringify(prep));
  check('prepare-restart: пауза', audio.paused === true);
  check('prepare-restart: перемотка на 0:00', audio.currentTime === 0,
    String(audio.currentTime));

  const play = await route({ type: 'play-now' });
  check('play-now: воспроизведение запущено', play && play.playing === true,
    JSON.stringify(play));
  check('play-now: элемент не на паузе', audio.paused === false);

  console.log(failed ? 'RESTART FAIL: ' + failed : 'RESTART OK');
  process.exit(failed ? 1 : 0);
})();
