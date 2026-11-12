// content.js — Tab Audio Capture Study: ПАССИВНЫЙ наблюдатель.
//
// Платформы: Udio и Suno. У обеих звук играет через blob:-src (MSE/Blob), а
// метаданные песни уже присутствуют в HTML (Next.js flight data). Suno отдаёт
// их в self.__next_f без дополнительных запросов; Udio — в script-блоках плюс
// same-origin /api/songs.
//
// В v1 этот скрипт перехватывал звук через createMediaElementSource + ScriptProcessorNode
// в главном потоке страницы: это (а) перенаправляло звук плеера в контекст расширения
// («не слышно вообще» при suspended-контексте), (б) давало провалы/треск, когда
// главный поток Next.js-страницы был занят, (в) ломалось при сворачивании вкладки.
//
// Теперь звук пишет offscreen-документ через chrome.tabCapture (браузерный процесс,
// после расшифровки CDM). Отсюда нужно только:
//   - метаданные песни (id/artist/title/обложка из данных страницы)
//   - события плеера (play/ended) — СЛУШАЕМ, ничего не перенаправляем
//   - команда «перемотать на 0:00 и запустить» для записи с начала

(() => {
  if (window.__udioDlInstalled) return;
  window.__udioDlInstalled = true;

  const log = (...a) => console.log('[udio-dl]', ...a);

  function detectSite() {
    const h = location.hostname;
    if (/(^|\.)suno\.com$/i.test(h)) return 'suno';
    if (/(^|\.)udio\.com$/i.test(h)) return 'udio';
    return null;
  }

  // ---------- метаданные страницы ----------

  const metaCache = { url: null, data: null };

  // Suno: все SSR-данные лежат в вызовах self.__next_f.push([1,"..."]).
  // Строковый литерал — валидный JSON-стринг, поэтому JSON.parse снимает
  // экранирование и склеенные куски дают единый flight-текст.
  function decodeNextFlight() {
    const out = [];
    const re = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;
    document.querySelectorAll('script').forEach((s) => {
      const txt = s.textContent || '';
      if (txt.indexOf('self.__next_f.push') < 0) return;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(txt))) {
        try { out.push(JSON.parse(m[1])); } catch (e) { /* пропускаем битый кусок */ }
      }
    });
    return out.join('');
  }

  // Возвращает индекс закрывающей '}' для объекта, начинающегося в start.
  // Учитывает строки и escape-последовательности, поэтому '}' внутри title
  // не обрывает объект.
  function scanObjectEnd(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function collectSongObjects(text) {
    const needle = '"entity_type":"song_schema"';
    const out = [];
    let from = 0;
    for (;;) {
      const idx = text.indexOf(needle, from);
      if (idx < 0) break;
      from = idx + needle.length;
      // ближайшая '{' может оказаться внутри строкового значения (prompt
      // с фигурной скобкой) — пробуем предыдущие, пока JSON не разберётся
      let start = text.lastIndexOf('{', idx);
      while (start >= 0) {
        const end = scanObjectEnd(text, start);
        if (end > idx) {
          try {
            const o = JSON.parse(text.slice(start, end + 1));
            if (o && o.entity_type === 'song_schema') { out.push(o); break; }
          } catch (e) { /* пробуем более внешний объект */ }
        }
        start = text.lastIndexOf('{', start - 1);
      }
    }
    return out;
  }

  function parseSunoMeta() {
    const flight = decodeNextFlight();
    if (!flight) return null;
    let objs = collectSongObjects(flight);
    if (!objs.length) {
      // иногда состояние вложено в JSON-строку ещё раз — снимаем один слой
      const un = flight.replace(/\\"/g, '"');
      if (un !== flight) objs = collectSongObjects(un);
    }
    if (!objs.length) return null;

    // на странице /song/<uuid> выбираем именно этот клип, иначе — готовый
    // (status: complete) с названием
    const pathId = (location.pathname.match(/\/song\/([0-9a-f-]{36})/i) || [])[1] || null;
    const clip = (pathId && objs.find((o) => o.id === pathId)) ||
      objs.find((o) => o.title && o.status === 'complete') || objs[0];
    if (!clip || !clip.id) return null;

    const md = clip.metadata || {};
    return {
      site: 'Suno',
      uuid: clip.id,
      artist: clip.display_name || clip.handle || 'Suno',
      title: clip.title || 'song',
      image: clip.image_large_url || clip.image_url || null,
      genre: md.tags || null,
      duration: md.duration != null ? md.duration : null,
      published: String(clip.created_at || '').slice(0, 10),
      parsed: true,
    };
  }

  async function parseUdioMeta() {
    // UUID/artist/title ищем в данных страницы (Next.js flight data)
    const html = Array.from(document.querySelectorAll('script'))
      .map((s) => s.textContent).join('\n');
    const un = html.replace(/\\u0022/g, '"').replace(/\\"/g, '"');
    const re = /"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})","user_id":"[0-9a-f-]{36}","artist":"([^"]*)","artist_image":"[^"]*","title":"([^"]*)"/;
    const m = un.match(re);
    if (!m) return null;
    const meta = { site: 'Udio', uuid: m[1], artist: m[2], title: m[3], parsed: true };
    try {
      const r = await fetch('/api/songs?songIds=' + m[1], { credentials: 'include' });
      const j = await r.json();
      const sng = j.songs && j.songs[0];
      if (sng) {
        meta.artist = sng.artist || meta.artist;
        meta.title = sng.title || meta.title;
        meta.image = sng.image_path || null;
        meta.lyrics = sng.lyrics || null;
        meta.duration = sng.duration || null;
        meta.published = (sng.published_at || sng.created_at || '').slice(0, 10);
      }
    } catch (e) { log('API fetch failed:', e && e.message); }
    return meta;
  }

  function fallbackMeta(site) {
    // У Suno заголовок вида "<Song> by <Artist> | Suno";
    // у Udio — "<Artist> - <Song>".
    const t = (document.title || '').replace(/\s*\|\s*(?:Udio|Suno)\s*$/i, '').trim();
    if (site === 'suno') {
      const by = t.lastIndexOf(' by ');
      if (by > 0) {
        return {
          site: 'Suno',
          artist: t.slice(by + 4).trim() || 'Suno',
          title: t.slice(0, by).trim() || 'song',
        };
      }
      return { site: 'Suno', artist: 'Suno', title: t || 'song' };
    }
    const parts = t.split(' - ');
    return {
      site: site === 'udio' ? 'Udio' : 'Tab',
      artist: parts.length > 1 ? parts.shift() : 'Udio',
      title: parts.join(' - ') || t || 'song',
    };
  }

  async function getPageTrackMeta() {
    const url = location.href.split('#')[0];
    if (metaCache.url === url && metaCache.data) return metaCache.data;
    const site = detectSite();
    let meta = null;
    try {
      meta = site === 'suno' ? parseSunoMeta() : await parseUdioMeta();
    } catch (e) { log('метаданные:', e && e.message); }
    if (!meta) meta = fallbackMeta(site);
    // запасной вариант не кэшируем: SSR-данные могут появиться чуть позже
    if (meta.parsed) {
      metaCache.url = url;
      metaCache.data = meta;
    }
    return meta;
  }

  async function fetchCoverB64(url) {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) return null;
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      }
      return btoa(bin);
    } catch (e) { return null; }
  }

  // ---------- пассивное наблюдение за плеером (БЕЗ WebAudio) ----------

  const SUNO_ACTIVE_ID = 'active-audio-play';
  const watched = new WeakSet();
  let mainEl = null;
  let captureActive = false; // приходит из SW: идёт ли запись
  let holdUntil = 0; // до этого времени глушим автостарт плеера после конца песни
  const HOLD_MS = 5000;

  function isSilentAudio(el) {
    if (!el) return false;
    // Suno держит <audio id="silent-audio"> для обхода autoplay-политики —
    // его нельзя принимать за основной плеер.
    return el.id === 'silent-audio' || /sil-100\.mp3/i.test(el.src || '');
  }

  function isMainPlayer(el) {
    if (!el || isSilentAudio(el)) return false;
    if (detectSite() === 'suno' && el.id === SUNO_ACTIVE_ID) return true;
    // основной плеер обеих платформ играет через MSE/Blob => blob:-src
    return (el.currentSrc || el.src || '').startsWith('blob:');
  }

  function findMainAudio() {
    if (detectSite() === 'suno') {
      // на Suno плеер устойчиво живёт в #active-audio-play и переживает
      // SPA-навигацию; silent-audio игнорируем
      const active = document.getElementById(SUNO_ACTIVE_ID);
      if (active && !isSilentAudio(active)) return active;
    }
    const els = Array.from(document.querySelectorAll('audio'));
    return els.find(isMainPlayer) || els.find((a) => !isSilentAudio(a)) || null;
  }

  function notify(type) {
    try {
      chrome.runtime.sendMessage({ type, from: 'content' }, () => void chrome.runtime.lastError);
    } catch (e) { /* ignore */ }
  }

  function watch(el) {
    if (watched.has(el)) return;
    watched.add(el);
    el.addEventListener('play', () => {
      if (Date.now() < holdUntil) {
        // только что закончилась записанная песня — глушим автоперезапуск
        // (у Suno это ещё и следующий трек очереди)
        try { el.pause(); } catch (e) { /* ignore */ }
        log('автостарт после конца песни остановлен');
        return;
      }
      if (isMainPlayer(el)) {
        mainEl = el;
        notify('playback-play');
      }
    });
    el.addEventListener('ended', () => {
      if (el !== mainEl) return;
      // Suno после 'ended' сам переключает очередь: если запись идёт,
      // hold ставим СРАЗУ — следующий трек не попадёт в хвост файла
      if (captureActive) holdUntil = Date.now() + HOLD_MS;
      // 1) быстрый стоп захвата НАПРЯМУЮ в offscreen (он жив, пока идёт запись):
      //    не ждём пробуждения SW — повторы не успеют попасть в хвост файла
      try {
        chrome.runtime.sendMessage(
          { target: 'offscreen', type: 'stop-recording', reason: 'song-ended' },
          (resp) => {
            if (chrome.runtime.lastError) return;
            if (resp && resp.ok && !resp.noop) {
              holdUntil = Date.now() + HOLD_MS; // запись шла — глушим автоплей
            }
          });
      } catch (e) { /* ignore */ }
      // 2) штатная цепочка: SW остановит (noop), продлит hold и сохранит файл
      notify('playback-ended');
    });
  }

  function scan() {
    const els = Array.from(document.querySelectorAll('audio'));
    const main = findMainAudio();
    if (main) mainEl = main;
    els.forEach(watch);
  }

  const obs = new MutationObserver(scan);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  scan();

  // ---------- команды от service worker ----------

  async function prepareRestart() {
    const el = findMainAudio();
    if (!el) return { ok: false, error: 'no-audio' };
    // глушим и перематываем ДО старта захвата: хвост прошлой позиции
    // не попадёт в запись вообще
    try { el.pause(); } catch (e) { /* ignore */ }
    try { el.currentTime = 0; } catch (e) { /* ignore */ }
    return { ok: true };
  }

  function findPlayButton() {
    // Suno: кнопка Play в плеере имеет ровно aria-label="Play" и меняет его
    // на "Pause"; у Udio — тоже подпись со словом Play.
    return document.querySelector('button[aria-label="Play" i]') ||
      document.querySelector("button[aria-label*='play' i]");
  }

  async function playNow() {
    const el = findMainAudio();
    if (!el) return { ok: false, error: 'no-audio' };
    if (!el.paused) return { ok: true, playing: true };
    // сначала пробуем напрямую: синтетический click из сообщения расширения
    // не даёт user activation, поэтому порядок «play() -> клик» надёжнее
    try { await el.play(); } catch (e) { log('play() отклонён:', e && e.name); }
    if (el.paused) {
      const btn = findPlayButton();
      if (btn) { try { btn.click(); } catch (e) { /* ignore */ } }
      await new Promise((r) => setTimeout(r, 150));
    }
    // если браузер всё равно требует жест — пользователь нажмёт Play сам;
    // запись при этом продолжится (просто будет тишина до старта)
    return { ok: true, playing: !el.paused };
  }

  function isSongPage() {
    if (detectSite() !== 'suno') return true;
    return /^\/song\/[0-9a-f-]{36}/i.test(location.pathname);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === 'status') {
          const meta = await getPageTrackMeta();
          const el = mainEl || findMainAudio();
          sendResponse({
            ok: true,
            site: detectSite(),
            songPage: isSongPage(),
            hasAudio: !!el,
            playback: el
              ? { paused: el.paused, t: el.currentTime, dur: el.duration || null }
              : null,
            meta: {
              artist: meta.artist, title: meta.title, site: meta.site || null,
              image: !!meta.image, duration: meta.duration || null,
            },
          });
        } else if (msg.type === 'get-meta') {
          sendResponse({ ok: true, meta: await getPageTrackMeta() });
        } else if (msg.type === 'get-cover') {
          sendResponse({ ok: true, b64: await fetchCoverB64(msg.url) });
        } else if (msg.type === 'prepare-restart') {
          sendResponse(await prepareRestart());
        } else if (msg.type === 'play-now') {
          sendResponse(await playNow());
        } else if (msg.type === 'recording-started') {
          captureActive = true;
          sendResponse({ ok: true });
        } else if (msg.type === 'recording-stopped') {
          captureActive = false;
          sendResponse({ ok: true });
        } else if (msg.type === 'hold-playback') {
          // SW подтвердил: запись закончилась — глушим автоплей на HOLD_MS
          holdUntil = Date.now() + HOLD_MS;
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'unknown' });
        }
      } catch (e) {
        try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (_) {}
      }
    })();
    return true; // асинхронный ответ
  });

  log('контент-скрипт загружен (v2, пассивный режим, Udio/Suno)');
})();
