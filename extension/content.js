// content.js — Udio Song Downloader v2: ПАССИВНЫЙ наблюдатель.
//
// В v1 этот скрипт перехватывал звук через createMediaElementSource + ScriptProcessorNode
// в главном потоке страницы: это (а) перенаправляло звук плеера в контекст расширения
// («не слышно вообще» при suspended-контексте), (б) давало провалы/треск, когда
// главный поток Next.js-страницы был занят, (в) ломалось при сворачивании вкладки.
//
// Теперь звук пишет offscreen-документ через chrome.tabCapture (браузерный процесс,
// после расшифровки CDM). Отсюда нужно только:
//   - метаданные песни (UUID/artist/title из Next.js-данных + /api/songs)
//   - обложка (base64 для offscreen)
//   - события плеера (play/ended) — СЛУШАЕМ, ничего не перенаправляем
//   - команда «перемотать на 0:00 и запустить» для записи с начала

(() => {
  if (window.__udioDlInstalled) return;
  window.__udioDlInstalled = true;

  const log = (...a) => console.log('[udio-dl]', ...a);

  // ---------- метаданные страницы (проверено в v1, работает) ----------

  const metaCache = { url: null, data: null };

  async function getPageTrackMeta() {
    const url = location.href.split('#')[0];
    if (metaCache.url === url && metaCache.data) return metaCache.data;
    let meta = null;
    try {
      // UUID/artist/title ищем в данных страницы (Next.js flight data)
      const html = Array.from(document.querySelectorAll('script'))
        .map((s) => s.textContent).join('\n');
      const un = html.replace(/\\u0022/g, '"').replace(/\\"/g, '"');
      const re = /"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})","user_id":"[0-9a-f-]{36}","artist":"([^"]*)","artist_image":"[^"]*","title":"([^"]*)"/;
      const m = un.match(re);
      if (m) {
        meta = { uuid: m[1], artist: m[2], title: m[3] };
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
      }
    } catch (e) { /* ignore */ }
    if (!meta) {
      const t = (document.title || '').replace(/\s*\|\s*Udio\s*$/i, '');
      const parts = t.split(' - ');
      meta = {
        artist: parts.length > 1 ? parts.shift() : 'Udio',
        title: parts.join(' - ') || t || 'song',
      };
    }
    metaCache.url = url;
    metaCache.data = meta;
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

  const watched = new WeakSet();
  let mainEl = null;
  let holdUntil = 0; // до этого времени глушим автостарт плеера после конца песни
  const HOLD_MS = 5000;

  function isMainPlayer(el) {
    // основной плеер Udio (Shaka) играет через MSE => blob:-src
    return (el.currentSrc || el.src || '').startsWith('blob:');
  }

  function findMainAudio() {
    const els = Array.from(document.querySelectorAll('audio'));
    return els.find((a) => (a.currentSrc || '').startsWith('blob:')) || els[0] || null;
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
    const main = els.find((a) => (a.currentSrc || '').startsWith('blob:'));
    if (main) mainEl = main;
    if (!mainEl && els.length) mainEl = els[0];
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

  async function playNow() {
    const el = findMainAudio();
    if (!el) return { ok: false, error: 'no-audio' };
    if (el.paused) {
      const btn = document.querySelector("button[aria-label*='Play' i]");
      if (btn) btn.click();
      try { await el.play(); } catch (e) { /* автоплей заблокирован — ждём ручного Play */ }
    }
    return { ok: true, playing: !el.paused };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === 'status') {
          const meta = await getPageTrackMeta();
          const el = mainEl || findMainAudio();
          sendResponse({
            ok: true,
            hasAudio: !!el,
            playback: el
              ? { paused: el.paused, t: el.currentTime, dur: el.duration || null }
              : null,
            meta: {
              artist: meta.artist, title: meta.title,
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

  log('контент-скрипт загружен (v2, пассивный режим)');
})();
