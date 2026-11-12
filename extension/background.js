// background.js — service worker Tab Audio Capture Study v2.
// Оркестрация: popup (жест пользователя) -> tabCapture.getMediaStreamId ->
// offscreen-документ (захват PCM в AudioWorklet + lamejs) -> chrome.downloads.
// Content script на udio.com / suno.com — только пассивный наблюдатель
// (метаданные, события play/ended плеера). Звук страницы не перенаправляется.

const OFFSCREEN_URL = 'offscreen.html';
const pending = new Map(); // downloadId -> blobUrl

// ---------- состояние (переживает перезапуск SW) ----------

async function getState() {
  try {
    const st = await chrome.storage.session.get('rec');
    return st.rec || {};
  } catch (e) { return {}; }
}

async function setState(patch) {
  const cur = await getState();
  await chrome.storage.session.set({ rec: Object.assign({}, cur, patch) });
}

async function getPrefs() {
  const st = await chrome.storage.local.get(['format', 'autoSave', 'autoTitle', 'manualMeta']);
  const mm = st.manualMeta || {};
  return {
    format: st.format === 'wav' ? 'wav' : 'mp3',
    autoSave: st.autoSave !== false, // по умолчанию ВКЛ
    autoTitle: st.autoTitle !== false, // по умолчанию ВКЛ: имя трека со страницы
    // ручное название/автор, сохранённые popup (нужны автосейву,
    // когда popup уже закрыт и opts.meta нет)
    manualMeta: {
      artist: String(mm.artist || '').trim(),
      title: String(mm.title || '').trim(),
    },
  };
}

// ---------- offscreen-документ ----------

async function getOffscreenDoc() {
  const contexts = await chrome.runtime.getContexts({});
  return contexts.find((c) => c.contextType === 'OFFSCREEN_DOCUMENT') || null;
}

async function ensureOffscreen() {
  const existing = await getOffscreenDoc();
  if (existing) return existing;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Запись звука вкладки (tabCapture) и кодирование в MP3/WAV',
    });
  } catch (e) {
    // уже создан другим вызовом — не страшно
  }
  return getOffscreenDoc();
}

function sendToOffscreenRaw(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg), (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: 'empty' });
      }
    });
  });
}

async function sendToOffscreen(msg) {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  let r = await sendToOffscreenRaw(msg);
  // сразу после createDocument слушатель может ещё не стоять — один ретрай
  if (r && r.ok === false && /Receiving end does not exist/.test(r.error || '')) {
    await new Promise((res) => setTimeout(res, 350));
    r = await sendToOffscreenRaw(msg);
  }
  return r;
}

// ---------- вкладки / content script ----------

function tabsSend(tabId, msg) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve({ ok: false, error: 'no-tab' });
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: 'no-content' });
      else resolve(resp || { ok: false, error: 'empty' });
    });
  });
}

// ---------- бейдж ----------

async function setBadge(mode) {
  try {
    if (mode === 'rec') {
      await chrome.action.setBadgeText({ text: 'REC' });
      await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
    } else if (mode === 'enc') {
      await chrome.action.setBadgeText({ text: 'ENC' });
      await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) { /* ignore */ }
}

// ---------- метаданные трека ----------
// Метаданные нужны в момент СОХРАНЕНИЯ, но к этому времени страница уже может
// показывать другой трек (Suno сам переключает очередь после 'ended'), быть
// перезагруженной или вообще недоступной. Поэтому снимок «что записываем»
// делается на старте записи и хранится в chrome.storage.session (переживает
// перезапуск service worker).

// «Качество» метаданных: разобранные из данных страницы/Media Session выше
// запасного варианта из document.title (parsed:false), у которого название
// часто вырождается в "song"/"recording".
function metaScore(m) {
  if (!m) return -1;
  let s = 0;
  if (m.parsed) s += 4;
  if (m.title && !/^(song|recording)$/i.test(m.title)) s += 2;
  if (m.artist && !/^(tab|udio|suno)$/i.test(m.artist)) s += 1;
  if (m.uuid) s += 1;
  return s;
}

// a — снимок со старта записи (главный), b — то, что страница отдаёт сейчас.
// Разные uuid — запись идёт про трек, который был на старте: страница уже
// уехала на следующий, её данные не подходят.
function pickMeta(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (a.uuid && b.uuid && a.uuid !== b.uuid) return a;
  return metaScore(b) > metaScore(a) ? b : a;
}

function sameTrack(a, b) {
  return !(a && b && a.uuid && b.uuid && a.uuid !== b.uuid);
}

// ---------- запись ----------

async function startRecording(tabId, mode) {
  if (tabId == null) return { ok: false, error: 'no-tab' };
  const st = await getState();
  if (st.capturing) await stopRecording('restart');

  if (mode === 'restart') {
    // 1) СНАЧАЛА глушим и перематываем на 0:00 — до старта захвата,
    //    чтобы хвост прошлой позиции вообще не попал в запись.
    //    Без content script (например, вкладка открыта до обновления
    //    расширения) перемотка и автостоп по 'ended' не работают —
    //    честно сообщаем об ошибке, а не пишем «с текущего места».
    const prep = await tabsSend(tabId, { type: 'prepare-restart' });
    if (!prep || prep.ok !== true) {
      const err = prep && prep.error === 'no-content' ? 'content-missing'
        : (prep && prep.error) || 'prepare-failed';
      console.warn('[udio-dl-sw] restart недоступен:', err);
      return { ok: false, error: err };
    }
  }

  // 2) getMediaStreamId вызывается по жесту (клик по иконке/кнопке popup) —
  // требование tabCapture; захватывает звуковую дорожку вкладки ПОСЛЕ CDM.
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    return { ok: false, error: 'capture-denied: ' + String(e && e.message || e) };
  }

  const r = await sendToOffscreen({ type: 'start-recording', data: streamId });
  if (!r || r.ok === false) return r;

  // состояние фиксируем ДО сообщения content script: иначе 'ended', пришедший
  // сразу после recording-started, увидит capturing:false и файл не сохранится
  await setState({
    capturing: true, tabId, mode, startedAt: Date.now(), savedThisRun: false, trackMeta: null,
  });
  await setBadge('rec');
  // content script начинает слышать 'ended' и защищать хвост записи
  // от автоперехода к следующему треку (Suno); его ответ — снимок метаданных
  // трека прямо сейчас, сохраняем его на весь проход записи
  const snap = await tabsSend(tabId, { type: 'recording-started' });
  const trackMeta = (snap && snap.meta) || null;
  if (trackMeta) {
    console.log('[udio-dl-sw] снимок метаданных:', trackMeta.artist + ' - ' + trackMeta.title);
    await setState({ trackMeta });
  }

  if (mode === 'restart') {
    // 3) сбрасываем буфер (страховка от хвостов) и запускаем воспроизведение
    await sendToOffscreen({ type: 'mark-cut' });
    await tabsSend(tabId, { type: 'play-now' });
  }
  return { ok: true };
}

async function stopRecording(reason) {
  const st = await getState();
  const r = await sendToOffscreen({ type: 'stop-recording' });
  await setState({ capturing: false, stopReason: reason || '', stoppedAt: Date.now() });
  await setBadge('');
  // снимаем captureActive в content script (Suno: разрешаем автостарт снова)
  if (st.tabId != null) tabsSend(st.tabId, { type: 'recording-stopped' });
  return r;
}

async function maybeAutoSave() {
  const st = await getState();
  if (st.savedThisRun) return; // уже сохранили в этом проходе
  const prefs = await getPrefs();
  // «с начала» — всегда автосохранение; «с текущего места» — по настройке
  if (st.mode === 'restart' || prefs.autoSave) {
    await setState({ savedThisRun: true });
    const r = await savePipeline({ meta: null, format: null }, true);
    console.log('[udio-dl-sw] автосохранение:', JSON.stringify(r));
  }
}

// ---------- сохранение ----------

async function savePipeline(opts, auto) {
  const st = await getState();
  const prefs = await getPrefs();
  const format = (opts && (opts.format === 'wav' || opts.format === 'mp3'))
    ? opts.format : prefs.format;

  // 1) снимок метаданных, сделанный на старте записи (главный источник)
  let meta = st.trackMeta || null;
  // 2) что страница отдаёт сейчас — может быть уже следующим треком, поэтому
  //    только дополняет снимок, а не заменяет его
  let liveMeta = null;
  let coverB64 = null;
  if (st.tabId != null) {
    const m = await tabsSend(st.tabId, { type: 'get-meta' });
    if (m && m.ok && m.meta) liveMeta = m.meta;
  }
  meta = pickMeta(meta, liveMeta);
  // обложка: у снимка её может не быть (Media Session без artwork) — берём
  // у живой страницы, если это тот же трек
  if (meta && !meta.image && liveMeta && liveMeta.image && sameTrack(meta, liveMeta)) {
    meta = Object.assign({}, meta, { image: liveMeta.image });
  }
  if (meta && meta.image && st.tabId != null) {
    const c = await tabsSend(st.tabId, { type: 'get-cover', url: meta.image });
    if (c && c.ok) coverB64 = c.b64 || null;
  }
  if (meta) {
    console.log('[udio-dl-sw] метаданные для файла:', meta.artist + ' - ' + meta.title,
      '(parsed=' + !!meta.parsed + ')');
  }

  // автор/название из popup: в авто-режиме главнее данные страницы,
  // в ручном — то, что ввёл пользователь; пустые поля заполняются взаимно.
  // Если popup закрыт (автосейв), в ручном режиме берём сохранённые значения.
  const manual = (opts && opts.meta) ? {
    artist: String(opts.meta.artist || '').trim(),
    title: String(opts.meta.title || '').trim(),
  } : prefs.manualMeta;
  const manualPatch = {};
  if (manual && manual.artist) manualPatch.artist = manual.artist;
  if (manual && manual.title) manualPatch.title = manual.title;
  if (manualPatch.artist || manualPatch.title) {
    meta = prefs.autoTitle
      ? Object.assign({}, manualPatch, meta || {})   // авто: страница перекрывает ручное
      : Object.assign({}, meta || {}, manualPatch);  // вручную: ввод перекрывает страницу
  }

  if (!meta) meta = { artist: 'Tab', title: 'recording' };

  if (!auto) await setBadge('enc');
  const r = await sendToOffscreen({ type: 'save', format, meta, coverB64 });
  if (!auto) await setBadge('');
  return r;
}

async function downloadFile(url, filename) {
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    pending.set(downloadId, url);
    return { ok: true, downloadId };
  } catch (e) {
    // не оставляем «висящий» blob-URL
    sendToOffscreen({ type: 'revoke', url });
    return { ok: false, error: String(e && e.message || e) };
  }
}

safeListener(chrome.downloads, 'onChanged', async (delta) => {
  if (!delta.state || !delta.state.current) return;
  const cur = delta.state.current;
  if (cur === 'complete' || cur === 'interrupted') {
    const url = pending.get(delta.id);
    if (url) {
      pending.delete(delta.id);
      await sendToOffscreen({ type: 'revoke', url }); // отпускаем blob-URL
    }
  }
});

// ---------- маршрутизация сообщений ----------

safeListener(chrome.runtime, 'onMessage', (msg, sender, sendResponse) => {
  // транзит content -> offscreen (быстрый стоп по 'ended'):
  // не отвечаем и не держим канал — отвечает offscreen
  if (msg && msg.target === 'offscreen') return;
  (async () => {
    try {
      const fromOffscreen = msg && msg.from === 'offscreen';
      const fromContent = !!(sender.tab && sender.tab.id != null) && !fromOffscreen;

      if (fromOffscreen) {
        if (msg.type === 'capture-ended') {
          // офскрин сам остановился (поток вкладки кончился / лимит времени)
          const st = await getState();
          await setState({ capturing: false, stopReason: msg.info && msg.info.reason });
          await setBadge('');
          if (st.tabId != null) tabsSend(st.tabId, { type: 'recording-stopped' });
          await maybeAutoSave();
          sendResponse({ ok: true });
        } else if (msg.type === 'download') {
          const r = await downloadFile(msg.url, msg.filename);
          sendResponse(r);
        } else {
          sendResponse({ ok: false, error: 'unknown' });
        }
        return;
      }

      if (fromContent) {
        if (msg.type === 'playback-ended') {
          const st = await getState();
          if (st.capturing && st.tabId === sender.tab.id) {
            // снимок метаданных вместе с событием: даже если service worker
            // успел выгрузиться с момента старта, название записанной песни
            // не потеряется
            if (msg.meta && msg.meta.parsed) {
              await setState({ trackMeta: pickMeta(st.trackMeta, msg.meta) });
            }
            await stopRecording('song-ended');
            // глушим автоплей плеера после конца записанной песни
            // (ДО автосейва — кодирование занимает секунды)
            await tabsSend(st.tabId, { type: 'hold-playback' });
            await maybeAutoSave();
          }
          sendResponse({ ok: true });
        } else if (msg.type === 'playback-play') {
          // информационно: плеер стартовал
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'unknown' });
        }
        return;
      }

      // из popup
      switch (msg && msg.type) {
        case 'status': {
          sendResponse(await status());
          break;
        }
        case 'start': {
          sendResponse(await startRecording(msg.tabId, msg.mode));
          break;
        }
        case 'stop': {
          sendResponse(await stopRecording('manual'));
          break;
        }
        case 'save': {
          sendResponse(await savePipeline({ meta: msg.meta, format: msg.format }, false));
          break;
        }
        case 'setFormat': {
          const v = msg.value === 'wav' ? 'wav' : 'mp3';
          await chrome.storage.local.set({ format: v });
          sendResponse({ ok: true, format: v });
          break;
        }
        case 'setAutoSave': {
          await chrome.storage.local.set({ autoSave: !!msg.value });
          sendResponse({ ok: true, autoSave: !!msg.value });
          break;
        }
        case 'setAutoTitle': {
          await chrome.storage.local.set({ autoTitle: !!msg.value });
          sendResponse({ ok: true, autoTitle: !!msg.value });
          break;
        }
        case 'setManualMeta': {
          const manualMeta = {
            artist: String((msg.meta && msg.meta.artist) || '').trim(),
            title: String((msg.meta && msg.meta.title) || '').trim(),
          };
          await chrome.storage.local.set({ manualMeta });
          sendResponse({ ok: true, manualMeta });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown' });
      }
    } catch (e) {
      try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (_) {}
    }
  })();
  return true; // асинхронный ответ
});

async function status() {
  const st = await getState();
  const prefs = await getPrefs();

  let off = { ok: false, capturing: false, encoding: false, last: null };
  const doc = await getOffscreenDoc();
  if (doc) {
    off = await sendToOffscreen({ type: 'status' });
  }

  let content = { ok: false };
  let activeTabId = st.tabId;
  if (activeTabId == null) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tabs[0] ? tabs[0].id : null;
  }
  if (activeTabId != null) {
    const c = await tabsSend(activeTabId, { type: 'status' });
    if (c && c.ok) content = c;
  }

  return {
    ok: true,
    capturing: !!(st.capturing && off.capturing),
    mode: st.mode || null,
    recording: off.capturing
      ? { seconds: off.seconds, maxLevel: off.maxLevel, ctxState: off.ctxState }
      : null,
    encoding: !!off.encoding,
    last: off.last || null,
    format: prefs.format,
    autoSave: prefs.autoSave,
    autoTitle: prefs.autoTitle,
    pageMeta: content.meta || null,
    storedMeta: st.trackMeta || null, // снимок со старта записи (если идёт запись)
    playback: content.playback || null,
    songPage: content.songPage !== false,
    hasAudio: !!content.hasAudio,
    hasContent: !!content.ok,
    tabId: activeTabId,
  };
}

// ---------- внешние события ----------
// ВАЖНО: топ-левел SW-кода НЕ ДОЛЖЕН бросать — иначе Service worker registration
// failed (Status code 15). Опциональные API оборачиваем в проверки.
function safeListener(obj, name, fn) {
  try {
    if (obj && obj[name] && obj[name].addListener) obj[name].addListener(fn);
  } catch (e) {
    console.warn('[udio-dl-sw] listener ' + name + ' не установлен:', e && e.message);
  }
}

// захват прекращён (навигация вкладки и т.п.) — финализируем что есть.
// Реагируем ТОЛЬКО на 'stopped': для собственного захвата Chrome тоже
// эмитит 'pending'/'active', и на 'pending' мы не должны убивать запись.
// (событие называется onStatusChanged — именно Status, не State!)
safeListener(chrome.tabCapture, 'onStatusChanged', async (info) => {
  try {
    const st = await getState();
    if (st.capturing && info.tabId === st.tabId && info.status === 'stopped') {
      await sendToOffscreen({ type: 'stop-recording' });
      await setState({ capturing: false, stopReason: 'capture-state-' + info.status });
      await setBadge('');
      tabsSend(st.tabId, { type: 'recording-stopped' });
      await maybeAutoSave();
    }
  } catch (e) { /* ignore */ }
});

safeListener(chrome.tabs, 'onRemoved', async (tabId) => {
  try {
    const st = await getState();
    if (st.capturing && st.tabId === tabId) {
      await sendToOffscreen({ type: 'stop-recording' });
      await setState({ capturing: false, stopReason: 'tab-closed' });
      await setBadge('');
      await maybeAutoSave();
    }
  } catch (e) { /* ignore */ }
});

console.log('[udio-dl-sw] service worker загружен (v2)');
