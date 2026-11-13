// test_acemusic.js — проверяет адаптер ACE Music в content.js:
//   1) get-meta без Media Session: название из DOM-карточки играющего <audio>;
//   2) Media Session главнее DOM-эвристики;
//   3) https-src (НЕ blob:) распознаётся как основной плеер ('play' -> событие);
//   4) 'ended' во время записи: быстрый стоп в offscreen + снимок метаданных;
//   5) hold автостарта после 'ended' и его сброс в prepare-restart;
//   6) play-now запускает плеер;
//   7) status отдаёт site/songPage/hasAudio.
// DOM и chrome API — минимальные заглушки, сеть не нужна.
const fs = require('fs');
const path = require('path');

class FakeAudio {
  constructor() {
    this.id = '';
    this.listeners = {};
    this.paused = true;
    this.currentTime = 42;
    this.currentSrc = 'https://web-resource-cdn.acemusic.ai/site/audio/demo-song.mp3';
    this.src = '';
    this.duration = 180;
    this.isConnected = true;
    this.parentElement = null; // назначается ниже
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

const audio = new FakeAudio();
const heading = { textContent: '  Demo Song Title  ' };
const playBtn = { clicked: 0, click() { this.clicked++; audio.play(); } };
// карточка: контейнер аудио с заголовком и своей кнопкой «Play: …»
const card = {
  parentElement: null, // назначается ниже (document.body)
  querySelector(sel) {
    if (/h[1-4]/.test(sel) && !/button/i.test(sel)) return heading;
    if (/button\[aria-label\^='Play'/i.test(sel)) return playBtn;
    return null;
  },
};
audio.parentElement = card;

const body = { parentElement: null };
card.parentElement = body;

const listeners = {};
const offscreenMsgs = [];
const swMsgs = [];

global.window = {};
global.location = {
  hostname: 'acemusic.ai',
  href: 'https://acemusic.ai/',
  pathname: '/',
};
global.document = {
  title: 'ACE Music — AI Songs from Your Ideas and Melodies',
  body,
  documentElement: {},
  querySelectorAll: (sel) => (sel === 'audio' ? [audio] : []),
  getElementById: () => null,
  querySelector: () => null,
};
global.MutationObserver = class {
  constructor(fn) { this.fn = fn; }
  observe() {}
};
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaSession: { metadata: null } },
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
  // 1) до всего: Media Session пуст — метаданные из DOM-карточки
  const dom = await route({ type: 'get-meta' });
  check('get-meta: название из DOM-карточки',
    dom && dom.meta && dom.meta.title === 'Demo Song Title',
    dom && dom.meta && dom.meta.title);
  check('get-meta: сайт ACE Music',
    dom && dom.meta && dom.meta.site === 'ACE Music',
    dom && dom.meta && dom.meta.site);
  check('get-meta: parsed=true (эвристика карточки)',
    dom && dom.meta && dom.meta.parsed === true);

  // 2) Media Session главнее DOM-эвристики
  global.navigator.mediaSession.metadata = {
    title: 'Session Song', artist: 'Session Artist', artwork: [],
  };
  const live = await route({ type: 'get-meta' });
  check('get-meta: Media Session главнее DOM',
    live && live.meta && live.meta.title === 'Session Song' &&
      live.meta.artist === 'Session Artist',
    live && live.meta && live.meta.title + '/' + live.meta.artist);
  global.navigator.mediaSession.metadata = null;

  // 3) https-src распознаётся как основной плеер
  await audio.play(); // dispatch 'play' -> playback-play
  check('play: событие playback-play в service worker',
    swMsgs.some((m) => m.type === 'playback-play'));
  audio.pause();

  // 4) запись идёт; Media Session уехала на следующий трек -> снимок важнее
  global.navigator.mediaSession.metadata = {
    title: 'Session Song', artist: 'Session Artist', artwork: [],
  };
  await route({ type: 'recording-started' });
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

  // 5) hold автостарта: play сразу после ended глушится
  await audio.play();
  check('hold: автостарт после конца песни остановлен',
    audio.paused === true, String(audio.paused));

  // 6) prepare-restart снимает hold, перематывает; play-now запускает
  const prep = await route({ type: 'prepare-restart' });
  check('prepare-restart: ok', prep && prep.ok === true, JSON.stringify(prep));
  check('prepare-restart: перемотка на 0:00', audio.currentTime === 0,
    String(audio.currentTime));

  const play = await route({ type: 'play-now' });
  check('play-now: воспроизведение запущено', play && play.playing === true,
    JSON.stringify(play));
  check('play-now: элемент не на паузе', audio.paused === false);

  // 7) status
  await route({ type: 'recording-stopped' });
  global.navigator.mediaSession.metadata = null;
  const st = await route({ type: 'status' });
  check('status: site=acemusic', st && st.site === 'acemusic', st && st.site);
  check('status: songPage=true', st && st.songPage === true);
  check('status: hasAudio=true', st && st.hasAudio === true);
  check('status: метаданные вернулись к карточке',
    st && st.meta && st.meta.title === 'Demo Song Title',
    st && st.meta && st.meta.title);

  console.log(failed ? 'ACEMUSIC FAIL: ' + failed : 'ACEMUSIC OK');
  process.exit(failed ? 1 : 0);
})();
