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
  // запись идёт; песня заканчивается → быстрый стоп + hold
  await route({ type: 'recording-started' });
  audio.dispatch('ended');
  check('ended: быстрый стоп в offscreen',
    offscreenMsgs.some((m) => m.type === 'stop-recording'));
  check('ended: событие в service worker',
    swMsgs.some((m) => m.type === 'playback-ended'));

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
