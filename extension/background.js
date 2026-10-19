// background.js — service worker Udio Song Downloader v2.
// Оркестрация: popup (жест пользователя) -> tabCapture.getMediaStreamId ->
// offscreen-документ (захват PCM в AudioWorklet + lamejs) -> chrome.downloads.
// Content script на udio.com — только пассивный наблюдатель (метаданные,
// события play/ended плеера). Звук страницы расширением не перенаправляется.

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
  const st = await chrome.storage.local.get(['format', 'autoSave']);
  return {
    format: st.format === 'wav' ? 'wav' : 'mp3',
    autoSave: st.autoSave !== false, // по умолчанию ВКЛ
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
      justification: 'Запись звука вкладки udio.com (tabCapture) и кодирование в MP3/WAV',
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

// ---------- запись ----------

async function startRecording(tabId, mode) {
  if (tabId == null) return { ok: false, error: 'no-tab' };
  const st = await getState();
  if (st.capturing) await stopRecording('restart');

  if (mode === 'restart') {
    // 1) СНАЧАЛА глушим и перематываем на 0:00 — до старта захвата,
    //    чтобы хвост прошлой позиции вообще не попал в запись
    await tabsSend(tabId, { type: 'prepare-restart' });
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

  await setState({ capturing: true, tabId, mode, startedAt: Date.now(), savedThisRun: false });
  await setBadge('rec');

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

  // метаданные со страницы (content script, same-origin fetch)
  let meta = null;
  let coverB64 = null;
  if (st.tabId != null) {
    const m = await tabsSend(st.tabId, { type: 'get-meta' });
    if (m && m.ok && m.meta) {
      meta = m.meta;
      if (meta.image) {
        const c = await tabsSend(st.tabId, { type: 'get-cover', url: meta.image });
        if (c && c.ok) coverB64 = c.b64 || null;
      }
    }
  }
  if (opts && opts.meta && (opts.meta.artist || opts.meta.title)) {
    meta = Object.assign({}, meta || {}, opts.meta);
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
          await setState({ capturing: false, stopReason: msg.info && msg.info.reason });
          await setBadge('');
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
    pageMeta: content.meta || null,
    playback: content.playback || null,
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
