// popup.js — Tab Audio Capture Study v2 (UI, EN default + RU switch).
// All logic lives in the service worker; this file only renders status
// and sends commands. UI language: 'en' by default, toggle persisted
// in chrome.storage.local ('lang').

let tabId = null;
let lastStatus = null;
let lang = 'en';

const STR = {
  en: {
    checking: 'Checking page…',
    artist: 'Artist',
    title: 'Title',
    format: 'Format:',
    wavOpt: 'WAV · lossless',
    btnRestart: '↻ Record song from start (auto-save)',
    btnRecord: '● Record from current position',
    btnStop: '⏹ Stop recording',
    btnSave: '💾 Save last recording',
    autoTitle: 'Track title from page (auto)',
    autoSave: 'Auto-save (current-position mode)',
    hint: 'Recording happens at the browser level (tabCapture): no DRM blocks, no crackle, speakers play as usual. Player hiccups/pauses longer than 1.5 s are cut from the file automatically. While recording, the tab is marked with a “recording” icon. Don\'t mute the player or close the tab.',
    statusFail: 'Failed to get status: ',
    wavEncoding: '⏳ Building WAV…',
    mp3Encoding: '⏳ Encoding MP3 (lamejs, ~10–20 s)…',
    recording: '● Recording: ',
    outOf: ' of ',
    track: ' (track: ',
    silenceWarn: '\n⚠️ Silence so far — make sure the song is playing and sound is on.',
    ctxWarn: '\n⚠️ AudioContext: ',
    ready: '✅ Recording ready to save: ',
    openSongPage: 'Open a song page on Udio, Suno or ACE Music and start playback.',
    playerFound: 'Player found. "Record from start" will rewind,\nrecord to the end and save the file automatically.',
    playerPending: 'Page is open, but the player is not created yet.\nPress Play on the page.',
    rewindMsg: '↻ The track is being rewound to 0:00 and recorded.\nThe file will appear in Downloads when the song ends.',
    startFail: 'Failed to start recording: ',
    errContentMissing: 'The page script is not connected. Reload the tab (Ctrl+R) — the extension was updated or reloaded.',
    errNoAudio: 'Player not found on the page. Start playback once, then try again.',
    errPrepareFailed: 'Could not rewind the track. Reload the tab and try again.',
    encodingDots: '⏳ Encoding…',
    saved: '💾 Saved: ',
    seeDownloads: ' MB) — see browser Downloads.',
    noRecording: 'No completed recording. Record a song first.',
    errorPrefix: 'Error: ',
    unknown: 'unknown',
  },
  ru: {
    checking: 'Проверяю страницу…',
    artist: 'Исполнитель',
    title: 'Название',
    format: 'Формат:',
    wavOpt: 'WAV · без потерь',
    btnRestart: '↻ Записать песню с начала (автосейв)',
    btnRecord: '● Записать с текущего места',
    btnStop: '⏹ Остановить запись',
    btnSave: '💾 Сохранить последнюю запись',
    autoTitle: 'Название трека со страницы (авто)',
    autoSave: 'Автосохранение «с текущего места»',
    hint: 'Запись — на уровне браузера (tabCapture): без DRM-блокировок, без треска, звук в колонках идёт как обычно. Заики/паузы плеера дольше 1,5 с вырезаются из файла автоматически. Во время записи вкладка помечается значком «запись». Не выключайте звук плеера и не закрывайте вкладку.',
    statusFail: 'Не удалось получить статус: ',
    wavEncoding: '⏳ Собираю WAV…',
    mp3Encoding: '⏳ Кодирую MP3 (lamejs, ~10–20 с)…',
    recording: '● Идёт запись: ',
    outOf: ' из ',
    track: ' (трек: ',
    silenceWarn: '\n⚠️ Пока тишина — проверьте, что песня играет и звук не выключен.',
    ctxWarn: '\n⚠️ Аудиоконтекст: ',
    ready: '✅ Запись готова к сохранению: ',
    openSongPage: 'Откройте страницу песни на Udio, Suno или ACE Music и включите воспроизведение.',
    playerFound: 'Плеер найден. «Записать с начала» — перемотает трек,\nзапишет до конца и сохранит файл автоматически.',
    playerPending: 'Страница открыта, но плеер ещё не создан.\nНажмите Play на странице.',
    rewindMsg: '↻ Трек перематывается на 0:00 и записывается.\nФайл появится в «Загрузках» по окончании песни.',
    startFail: 'Не удалось начать запись: ',
    errContentMissing: 'Скрипт страницы не подключён. Обновите вкладку (Ctrl+R) — расширение было обновлено или перезагружено.',
    errNoAudio: 'Плеер не найден на странице. Включите воспроизведение один раз и попробуйте снова.',
    errPrepareFailed: 'Не удалось перемотать трек. Обновите вкладку и попробуйте снова.',
    encodingDots: '⏳ Кодирую…',
    saved: '💾 Сохранено: ',
    seeDownloads: ' МБ) — см. «Загрузки» браузера.',
    noRecording: 'Нет завершённой записи. Сначала запишите песню.',
    errorPrefix: 'Ошибка: ',
    unknown: 'неизвестно',
  },
};

const L = (k) => (STR[lang] && STR[lang][k]) || STR.en[k] || k;

function applyLang() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = L(el.getAttribute('data-i18n'));
  });
  document.documentElement.lang = lang;
  $('langEn').classList.toggle('active', lang === 'en');
  $('langRu').classList.toggle('active', lang === 'ru');
}

function setLang(next) {
  lang = next;
  applyLang();
  try { chrome.storage.local.set({ lang }); } catch (e) { /* ignore */ }
}

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    // from:'popup' — явный маркер источника: popup, открытый как вкладка
    // (тесты/диагностика), имеет sender.tab и без маркера ошибочно
    // классифицируется сервис-воркером как контент-скрипт
    chrome.runtime.sendMessage(Object.assign({ from: 'popup' }, msg), (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false, error: 'empty' });
    });
  });
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

// технические коды background -> понятный текст
function startErr(code) {
  if (code === 'content-missing' || code === 'no-content') return L('errContentMissing');
  if (code === 'no-audio') return L('errNoAudio');
  if (code === 'prepare-failed') return L('errPrepareFailed');
  return code || L('unknown');
}

function render(st) {
  const dot = $('dot');
  const status = $('status');

  $('restart').disabled = $('record').disabled = st.encoding || !st.ok;
  $('stop').style.display = st.capturing ? '' : 'none';
  $('restart').style.display = st.capturing ? 'none' : '';
  $('record').style.display = st.capturing ? 'none' : '';
  $('save').disabled = st.encoding || !st.last || st.capturing;

  if (!st.ok) {
    dot.className = 'dot';
    status.className = 'status err';
    status.textContent = L('statusFail') + (st.error || '?');
    return;
  }
  status.className = 'status';

  // синхронизируем выбранный формат
  if (st.format && !$('save').dataset.fmtTouched) {
    const radio = document.querySelector('input[name="fmt"][value="' + st.format + '"]');
    if (radio) radio.checked = true;
  }

  if (st.encoding) {
    dot.className = 'dot enc';
    status.textContent = st.format === 'wav' ? L('wavEncoding') : L('mp3Encoding');
    return;
  }

  if (st.capturing && st.recording) {
    dot.className = 'dot rec';
    const pb = st.playback;
    let txt = L('recording') + fmt(st.recording.seconds || 0);
    if (pb && !pb.paused && pb.dur) {
      txt += L('outOf') + fmt(pb.dur) + L('track') + fmt(pb.t) + ')';
    }
    if (st.recording.seconds > 8 && st.recording.maxLevel < 0.003) {
      txt += L('silenceWarn');
    }
    if (st.recording.ctxState && st.recording.ctxState !== 'running') {
      txt += L('ctxWarn') + st.recording.ctxState;
    }
    status.textContent = txt;
    return;
  }

  if (st.last) {
    dot.className = 'dot ok';
    status.textContent = L('ready') + fmt(st.last.seconds);
    return;
  }

  dot.className = 'dot';
  if (!st.hasContent || st.songPage === false) {
    status.textContent = L('openSongPage');
  } else if (st.hasAudio) {
    status.textContent = L('playerFound');
  } else {
    status.textContent = L('playerPending');
  }
}

// Что показывать в полях «Исполнитель/Название». После остановки записи
// главное — снимок трека, который записывали (storedMeta): страница к этому
// моменту уже может показывать следующий трек (Suno переключает очередь).
function displayMeta(st) {
  if (st.storedMeta && (st.last || !st.pageMeta)) return st.storedMeta;
  return st.pageMeta || st.storedMeta || null;
}

async function refresh() {
  const st = await send({ type: 'status' });
  lastStatus = st;
  if (st.ok) {
    if (!$('autoTitle').dataset.touched) $('autoTitle').checked = st.autoTitle !== false;
    const autoTitle = st.autoTitle !== false;
    const pm = displayMeta(st);
    $('artist').readOnly = autoTitle;
    $('title').readOnly = autoTitle;
    if (autoTitle) {
      // авто-режим: поля всегда показывают имя трека, распарсенное из HTML страницы
      $('artist').value = (pm && pm.artist) || '';
      $('title').value = (pm && pm.title) || '';
    } else {
      if (document.activeElement !== $('artist') && !$('artist').dataset.touched) {
        $('artist').value = (pm && pm.artist) || '';
      }
      if (document.activeElement !== $('title') && !$('title').dataset.touched) {
        $('title').value = (pm && pm.title) || '';
      }
    }
    if (!$('autoSave').dataset.touched) $('autoSave').checked = !!st.autoSave;
    // НЕ перезаписываем tabId значением из статуса: st.tabId — это вкладка
    // последней записи, а не та, где стоит наводить новую запись. После
    // записи на Suno popup, открытый на Ace Music, «записывал» старую
    // вкладку Suno. Наша цель — активная вкладка на момент открытия popup.
  }
  render(st);
}

async function init() {
  try {
    const st = await chrome.storage.local.get(['lang']);
    if (st.lang === 'ru' || st.lang === 'en') lang = st.lang;
  } catch (e) { /* ignore */ }
  applyLang();
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tabs[0] ? tabs[0].id : null;
  await refresh();
  setInterval(refresh, 800);
}

// переключение языка
$('langEn').addEventListener('click', () => setLang('en'));
$('langRu').addEventListener('click', () => setLang('ru'));

// ручные значения переживают закрытие popup — их использует автосейв
let manualMetaTimer = null;
function persistManualMeta() {
  clearTimeout(manualMetaTimer);
  manualMetaTimer = setTimeout(() => {
    send({
      type: 'setManualMeta',
      meta: { artist: $('artist').value, title: $('title').value },
    });
  }, 400);
}

$('artist').addEventListener('input', () => {
  $('artist').dataset.touched = '1';
  persistManualMeta();
});
$('title').addEventListener('input', () => {
  $('title').dataset.touched = '1';
  persistManualMeta();
});

// авто/ручное название: в авто-режиме берём title/artist из HTML страницы
// (свежий parse при каждом сохранении), в ручном — то, что ввёл пользователь
$('autoTitle').addEventListener('change', async (e) => {
  e.target.dataset.touched = '1';
  const auto = e.target.checked;
  $('artist').readOnly = auto;
  $('title').readOnly = auto;
  if (auto) {
    delete $('artist').dataset.touched;
    delete $('title').dataset.touched;
  }
  await send({ type: 'setAutoTitle', value: auto });
  await refresh();
});

// старт записи — клик по кнопке popup считается жестом пользователя
// (требование chrome.tabCapture). Popup НЕ закрываем, чтобы видеть статус.
$('restart').addEventListener('click', async () => {
  $('restart').disabled = true;
  const r = await send({ type: 'start', mode: 'restart', tabId });
  if (r && r.ok) {
    const status = $('status');
    status.className = 'status';
    status.textContent = L('rewindMsg');
  } else {
    const status = $('status');
    status.className = 'status err';
    status.textContent = L('startFail') + startErr(r && r.error);
  }
  await refresh();
});

$('record').addEventListener('click', async () => {
  $('record').disabled = true;
  const r = await send({ type: 'start', mode: 'current', tabId });
  if (!(r && r.ok)) {
    const status = $('status');
    status.className = 'status err';
    status.textContent = L('startFail') + startErr(r && r.error);
  }
  await refresh();
});

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  await send({ type: 'stop' });
  await refresh();
});

$('save').addEventListener('click', async () => {
  $('save').disabled = true;
  const fmtEl = document.querySelector('input[name="fmt"]:checked');
  const format = fmtEl ? fmtEl.value : 'mp3';
  const status = $('status');
  status.className = 'status';
  status.textContent = L('encodingDots');
  // В авто-режиме поля — лишь отображение; отправляем их, только если
  // пользователь реально ввёл название (ручной режим). Иначе автозаполненные
  // значения (а после 'ended' страница может показывать уже следующий трек)
  // перекрыли бы снимок метаданных, сделанный на старте записи.
  const auto = !(lastStatus && lastStatus.autoTitle === false);
  const touched = $('artist').dataset.touched || $('title').dataset.touched;
  const meta = (auto && !touched) ? null
    : { artist: $('artist').value, title: $('title').value };
  const r = await send({ type: 'save', meta, format });
  if (r && r.ok) {
    status.className = 'status';
    status.textContent = L('saved') + r.name + ' (' +
      (r.size / 1048576).toFixed(1) + L('seeDownloads');
  } else {
    status.className = 'status err';
    status.textContent = r && r.error === 'no-recording'
      ? L('noRecording')
      : L('errorPrefix') + ((r && r.error) || L('unknown'));
  }
  await refresh();
});

// переключение формата
document.querySelectorAll('input[name="fmt"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    $('save').dataset.fmtTouched = '1';
    send({ type: 'setFormat', value: radio.value });
  });
});

$('autoSave').addEventListener('change', async (e) => {
  e.target.dataset.touched = '1';
  await send({ type: 'setAutoSave', value: e.target.checked });
});

init();
