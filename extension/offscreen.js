// offscreen.js — Udio Song Downloader v2 (захват звука вкладки + кодирование)
//
// Архитектура: chrome.tabCapture (браузерный процесс) перехватывает звук вкладки
// УЖЕ ПОСЛЕ расшифровки CDM — тот же сигнал, что идёт в колонки. Далее:
//   tab-поток -> MediaStreamSource -> AudioWorklet(pcm-collector, аудио-поток) -> колонки
//                                                 |
//                                                 v Int16-блоки -> сюда (главный поток
//                                                 лёгкого офскрин-документа, без SPA-нагрузки)
// Завершение: concat -> trim/fade -> lamejs MP3 320 или WAV -> blob -> chrome.downloads.
//
// Кодек-часть (trimAndFade / buildWav / buildId3 / encode) перенесена из v1.1
// без изменений — она проверена (dev-tools/test_lame.js, test_wav.js + ffprobe).

(() => {
  const S = {
    capturing: false,
    stream: null, ctx: null, node: null, source: null,
    chunks: [],            // [{l: Int16Array, r: Int16Array}]
    seconds: 0, maxLevel: 0,
    rate: 48000,
    startedAt: 0,
    last: null,            // {chunks, seconds, maxLevel, rate}
    encoding: false,
    urls: new Map(),       // blobUrl -> filename (пока идёт загрузка)
    capTimer: null,
    hasSound: false,       // был ли звук после старта (для сшивки/трима)
    silChunks: 0,          // подряд тихих блоков
    stitching: false,      // сейчас вырезаем заику
    droppedSec: 0,         // сколько секунд вырезано сшивкой
  };

  const MAX_SECONDS = 10 * 60;   // страховка: 10 минут
  const BITRATE = 320;
  const LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  // авто-сшивка заик плеера: тишина >= STITCH_MIN_SILENCE после первого звука
  // (HLS-ребуферинг, пауза) в файл не пишется — песня сшивается бесшовно
  const STITCH_MIN_SILENCE = 1.5;
  const STITCH_LEVEL = 0.003;   // порог «звук есть» (пик блока)

  const log = (...a) => console.log('[udio-dl-offscreen]', ...a);

  // ---------- сообщения (от service worker) ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return; // чужие сообщения игнорируем
    (async () => {
      try {
        switch (msg.type) {
          case 'start-recording': sendResponse(await startRecording(msg.data)); break;
          case 'stop-recording':  sendResponse(await stopRecording(msg.reason || 'manual')); break;
          case 'status':          sendResponse(statusInfo()); break;
          case 'save':            sendResponse(await saveRecording(msg)); break;
          case 'revoke':          revokeUrl(msg.url); sendResponse({ ok: true }); break;
          case 'mark-cut':        sendResponse(markCut()); break;
          default:                sendResponse({ ok: false, error: 'unknown-type' });
        }
      } catch (e) {
        log('ошибка обработки', msg.type, e && e.message);
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // асинхронный sendResponse
  });

  // ---------- захват ----------

  async function startRecording(streamId) {
    if (S.capturing) await stopRecording('restart');

    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    const track = media.getAudioTracks()[0];
    S.stream = media;

    const ctx = new AudioContext();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) { /* офскрин-страницы могут аудио без жеста */ }
    }
    await ctx.audioWorklet.addModule('worklet-processor.js');

    const node = new AudioWorkletNode(ctx, 'pcm-collector', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (ev) => {
      if (!S.capturing) return;
      const frames = ev.data.l.length;
      const sound = ev.data.peak > STITCH_LEVEL;
      if (sound) {
        S.hasSound = true;
        S.silChunks = 0;
        S.stitching = false;
      } else if (S.hasSound) {
        S.silChunks++;
        if (!S.stitching && (S.silChunks * frames) / S.rate >= STITCH_MIN_SILENCE) {
          S.stitching = true; // заика плеера: тишину вырезаем
          // откатываем уже записанные тихие блоки — тишина началась до триггера
          const n = Math.min(S.silChunks - 1, S.chunks.length);
          if (n > 0) {
            S.chunks.length -= n;
            S.seconds -= (n * frames) / S.rate;
            S.droppedSec += (n * frames) / S.rate;
          }
          log('тишина >= ' + STITCH_MIN_SILENCE + 'с — вырезаю (заика/пауза)');
        }
      }
      if (S.stitching) {
        S.droppedSec += frames / S.rate;
        return; // тишину в файл не пишем; звук вернётся — сшивка бесшовная
      }
      S.chunks.push({ l: ev.data.l, r: ev.data.r });
      S.seconds += frames / S.rate;
      if (ev.data.peak > S.maxLevel) S.maxLevel = ev.data.peak;
    };

    const source = ctx.createMediaStreamSource(media);
    source.connect(node);
    node.connect(ctx.destination); // pass-through: пользователь слышит запись

    S.node = node; S.source = source; S.ctx = ctx;
    S.rate = ctx.sampleRate;        // ворклет работает на частоте контекста
    S.chunks = []; S.seconds = 0; S.maxLevel = 0;
    S.hasSound = false; S.silChunks = 0; S.stitching = false; S.droppedSec = 0;
    S.capturing = true;
    S.startedAt = Date.now();

    track.addEventListener('ended', () => {
      if (S.capturing) autoStop('track-ended');
    });
    S.capTimer = setTimeout(() => {
      if (S.capturing) autoStop('max-duration');
    }, MAX_SECONDS * 1000);

    window.location.hash = 'recording';
    log('захват начат: ctxRate=' + ctx.sampleRate +
        ', streamRate=' + (track.getSettings().sampleRate || '?') +
        ', каналов в потоке: ' + (track.getSettings().channelCount || '?'));

    return { ok: true, ctxRate: ctx.sampleRate, streamRate: track.getSettings().sampleRate || null };
  }

  async function autoStop(reason) {
    const info = await stopRecording(reason);
    try {
      chrome.runtime.sendMessage({ from: 'offscreen', type: 'capture-ended', info },
        () => void chrome.runtime.lastError);
    } catch (e) { /* ignore */ }
  }

  async function stopRecording(reason) {
    if (!S.capturing) return { ok: true, noop: true };
    clearTimeout(S.capTimer);
    S.capturing = false;
    window.location.hash = '';

    const secs = S.seconds;
    const level = S.maxLevel;
    const rate = S.rate;

    try { S.stream && S.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { S.source && S.source.disconnect(); } catch (e) { /* ignore */ }
    try { S.node && S.node.port.close(); } catch (e) { /* ignore */ }
    try { S.node && S.node.disconnect(); } catch (e) { /* ignore */ }
    try { S.ctx && S.ctx.close(); } catch (e) { /* ignore */ }
    S.stream = S.ctx = S.node = S.source = null;

    if (S.chunks.length && secs >= 5 && level > 0.002) {
      S.last = { chunks: S.chunks, seconds: secs, maxLevel: level, rate };
      log('запись завершена (' + reason + '):', secs.toFixed(1) + 'с, уровень ' +
        level.toFixed(3) + (S.droppedSec > 0.3
          ? ', заик/пауз вырезано: ' + S.droppedSec.toFixed(1) + 'с'
          : ''));
    } else {
      // короткая/тихая запись не затирает предыдущую удачную
      log('запись короткая/тихая — отброшена:', secs.toFixed(1) + 'с, уровень ' + level.toFixed(3));
    }
    S.chunks = []; S.seconds = 0; S.maxLevel = 0;
    S.hasSound = false; S.silChunks = 0; S.stitching = false; S.droppedSec = 0;
    return { ok: true, reason, seconds: secs, maxLevel: level, rate };
  }

  // сброс буфера по команде SW (например, сразу после старта «с начала»,
  // чтобы хвост прошлой позиции гарантированно не попал в файл)
  function markCut() {
    if (!S.capturing) return { ok: false, error: 'not-capturing' };
    S.chunks = []; S.seconds = 0; S.maxLevel = 0;
    S.hasSound = false; S.silChunks = 0; S.stitching = false; S.droppedSec = 0;
    log('mark-cut: буфер записи сброшен');
    return { ok: true };
  }

  function statusInfo() {
    return {
      ok: true,
      capturing: S.capturing,
      seconds: S.seconds,
      maxLevel: S.maxLevel,
      encoding: S.encoding,
      ctxState: S.ctx ? S.ctx.state : null,
      last: S.last
        ? { seconds: S.last.seconds, maxLevel: S.last.maxLevel, rate: S.last.rate }
        : null,
    };
  }

  // ---------- кодирование (проверенная часть из v1.1) ----------

  function sanitize(name) {
    return (name || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function concatU8(arrs) {
    let n = 0;
    for (const a of arrs) n += a.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }

  function concatChunks(last) {
    let total = 0;
    for (const c of last.chunks) total += c.l.length;
    const L = new Int16Array(total);
    const R = new Int16Array(total);
    let o = 0;
    for (const c of last.chunks) { L.set(c.l, o); R.set(c.r, o); o += c.l.length; }
    return { L, R };
  }

  function trimAndFade(L, R, rate) {
    const block = Math.max(1, Math.floor(rate * 0.05)); // 50 мс
    const n = L.length;
    const nb = Math.floor(n / block);
    const rms = (off) => {
      let s2 = 0;
      for (let i = off; i < off + block; i++) { const v = L[i]; s2 += v * v; }
      return Math.sqrt(s2 / block);
    };
    const thr = 190; // ~-44 дБ
    let b0 = 0;
    while (b0 < nb && b0 < 160 && rms(b0 * block) < thr) b0++;        // до 8 с в начале
    let b1 = nb - 1;
    while (b1 > b0 && nb - 1 - b1 < 100 && rms(b1 * block) < thr) b1--; // до 5 с в конце
    const start = b0 * block;
    const end = Math.min(n, (b1 + 1) * block);
    const fi = Math.min(Math.floor(rate * 0.01), end - start);
    for (let i = 0; i < fi; i++) {
      const g = i / fi;
      L[start + i] = Math.round(L[start + i] * g);
      R[start + i] = Math.round(R[start + i] * g);
    }
    const fo = Math.min(Math.floor(rate * 0.02), end - start);
    for (let i = 0; i < fo; i++) {
      const g = i / fo;
      L[end - 1 - i] = Math.round(L[end - 1 - i] * g);
      R[end - 1 - i] = Math.round(R[end - 1 - i] * g);
    }
    return { L: L.subarray(start, end), R: R.subarray(start, end) };
  }

  // ---------- WAV (RIFF/WAVE, 16-bit PCM + LIST INFO) ----------

  function asciiBytes(str) {
    const a = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
    return a;
  }

  function wavInfoSub(id, text) {
    const t = new TextEncoder().encode(String(text));
    const size = t.length + 1;
    const out = new Uint8Array(8 + size + (size % 2));
    out.set(asciiBytes(id), 0);
    out[4] = size & 255; out[5] = (size >> 8) & 255;
    out[6] = (size >> 16) & 255; out[7] = (size >> 24) & 255;
    out.set(t, 8);
    out[8 + t.length] = 0;
    return out;
  }

  function buildWavInfoChunk(meta) {
    if (!meta) return new Uint8Array(0);
    const parts = [];
    if (meta.title) parts.push(wavInfoSub('INAM', meta.title));
    if (meta.artist) parts.push(wavInfoSub('IART', meta.artist));
    parts.push(wavInfoSub('IPRD', 'Udio'));
    if (meta.published) parts.push(wavInfoSub('ICRD', String(meta.published).slice(0, 4)));
    let body = 4;
    for (const p of parts) body += p.length;
    const chunk = new Uint8Array(8 + body);
    chunk.set(asciiBytes('LIST'), 0);
    chunk[4] = body & 255; chunk[5] = (body >> 8) & 255;
    chunk[6] = (body >> 16) & 255; chunk[7] = (body >> 24) & 255;
    chunk.set(asciiBytes('INFO'), 8);
    let o = 12;
    for (const p of parts) { chunk.set(p, o); o += p.length; }
    return chunk;
  }

  function buildWav(L, R, rate, meta) {
    const numCh = 2;
    const bps = 2;
    const n = L.length;
    const dataSize = n * numCh * bps;
    const info = buildWavInfoChunk(meta);
    const total = 12 + info.length + 24 + 8 + dataSize;
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    let o = 0;
    const wstr = (s2) => { for (let i = 0; i < s2.length; i++) dv.setUint8(o + i, s2.charCodeAt(i)); o += s2.length; };
    const w32 = (v) => { dv.setUint32(o, v, true); o += 4; };
    const w16 = (v) => { dv.setUint16(o, v, true); o += 2; };
    wstr('RIFF'); w32(total - 8); wstr('WAVE');
    if (info.length) { buf.set(info, o); o += info.length; }
    wstr('fmt '); w32(16); w16(1); w16(numCh); w32(rate);
    w32(rate * numCh * bps); w16(numCh * bps); w16(16);
    wstr('data'); w32(dataSize);
    const inter = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) {
      inter[2 * i] = L[i];
      inter[2 * i + 1] = R[i];
    }
    buf.set(new Uint8Array(inter.buffer), o);
    return buf;
  }

  // ---------- ID3v2.3 ----------

  function u16le(str) {
    const out = [0xff, 0xfe];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out.push(c & 0xff, (c >> 8) & 0xff);
    }
    return Uint8Array.from(out);
  }

  function id3Frame(id, payload) {
    const f = new Uint8Array(10 + payload.length);
    f.set(asciiBytes(id), 0);
    const sz = payload.length;
    f[4] = (sz >>> 24) & 255; f[5] = (sz >>> 16) & 255;
    f[6] = (sz >>> 8) & 255; f[7] = sz & 255;
    f.set(payload, 10);
    return f;
  }

  function textFrame(id, text) {
    const t = u16le(String(text));
    const p = new Uint8Array(1 + t.length);
    p[0] = 1; // UTF-16 с BOM
    p.set(t, 1);
    return id3Frame(id, p);
  }

  function coverMime(u8) {
    if (!u8 || u8.length < 12) return null;
    if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'image/jpeg';
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'image/png';
    if (u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
    return null;
  }

  function buildId3(meta, cover) {
    const frames = [];
    if (meta.title) frames.push(textFrame('TIT2', meta.title));
    if (meta.artist) frames.push(textFrame('TPE1', meta.artist));
    frames.push(textFrame('TALB', 'Udio'));
    if (meta.published) frames.push(textFrame('TYER', String(meta.published).slice(0, 4)));
    frames.push(textFrame('TCON', 'Udio'));
    if (meta.lyrics) {
      const desc = u16le('');
      const text = u16le(String(meta.lyrics).slice(0, 4000));
      const p = new Uint8Array(1 + 3 + desc.length + 2 + text.length);
      let o = 0;
      p[o++] = 1;
      p.set(asciiBytes('eng'), o); o += 3;
      p.set(desc, o); o += desc.length;
      p[o++] = 0; p[o++] = 0;
      p.set(text, o);
      frames.push(id3Frame('USLT', p));
    }
    const mime = coverMime(cover);
    if (cover && cover.length && mime) {
      const m = asciiBytes(mime);
      const p = new Uint8Array(1 + m.length + 1 + 1 + 4 + cover.length);
      let o = 0;
      p[o++] = 1;
      p.set(m, o); o += m.length;
      p[o++] = 0;
      p[o++] = 3;
      p[o++] = 0xff; p[o++] = 0xfe; p[o++] = 0; p[o++] = 0;
      p.set(cover, o);
      frames.push(id3Frame('APIC', p));
    }
    const body = concatU8(frames);
    const tag = new Uint8Array(10 + body.length);
    tag.set(asciiBytes('ID3'), 0);
    tag[3] = 3; tag[4] = 0; tag[5] = 0;
    const sz = body.length; // syncsafe-размер
    tag[6] = (sz >>> 21) & 0x7f; tag[7] = (sz >>> 14) & 0x7f;
    tag[8] = (sz >>> 7) & 0x7f; tag[9] = sz & 0x7f;
    tag.set(body, 10);
    return tag;
  }

  // ---------- сборка файла ----------

  async function encodeMp3(L, R, rate) {
    const enc = new lamejs.Mp3Encoder(2, rate, BITRATE);
    const parts = [];
    const BLK = 1152 * 8;
    let cnt = 0;
    for (let off = 0; off < L.length; off += BLK) {
      const end = Math.min(off + BLK, L.length);
      const buf = enc.encodeBuffer(L.subarray(off, end), R.subarray(off, end));
      if (buf.length) parts.push(new Uint8Array(buf));
      if (++cnt % 50 === 0) await new Promise((r) => setTimeout(r));
    }
    const fin = enc.flush();
    if (fin.length) parts.push(new Uint8Array(fin));
    return parts;
  }

  async function saveRecording(msg) {
    if (S.capturing) return { ok: false, error: 'still-capturing' };
    if (!S.last) return { ok: false, error: 'no-recording' };
    if (S.encoding) return { ok: false, error: 'busy' };

    const format = (msg.format === 'wav') ? 'wav' : 'mp3';
    const meta = msg.meta || null;
    const cover = msg.coverB64 ? b64ToU8(msg.coverB64) : null;

    if (format === 'mp3' && LAME_RATES.indexOf(S.last.rate) === -1) {
      // непонятная частота контекста — сохраняем WAV, MP3 невозможен
      return { ok: false, error: 'bad-rate-' + S.last.rate + ' (выберите WAV)' };
    }

    S.encoding = true;
    try {
      const raw = concatChunks(S.last);
      const { L, R } = trimAndFade(raw.L, raw.R, S.last.rate);

      let data;
      if (format === 'wav') {
        data = buildWav(L, R, S.last.rate, meta);
      } else {
        const parts = await encodeMp3(L, R, S.last.rate);
        data = concatU8([buildId3(meta, cover)].concat(parts));
      }

      const ext = format === 'wav' ? '.wav' : '.mp3';
      const name = sanitize((meta && (meta.artist || 'Tab')) + ' - ' +
        (meta && (meta.title || 'recording'))) + ext;
      const blob = new Blob([data], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      S.urls.set(url, name);

      // отдаём файл сервис-воркеру на загрузку; URL живёт, пока мы не отозвали
      chrome.runtime.sendMessage(
        { from: 'offscreen', type: 'download', url, filename: name, size: data.length },
        () => void chrome.runtime.lastError);

      S.last = null; // запись потреблена
      log('сохранено:', name, (data.length / 1048576).toFixed(1) + ' МБ [' + format + ']');
      return { ok: true, name, size: data.length };
    } catch (e) {
      log('ошибка кодирования:', e && e.message);
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      S.encoding = false;
    }
  }

  function b64ToU8(b64) {
    try {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    } catch (e) { return null; }
  }

  function revokeUrl(url) {
    if (S.urls.has(url)) {
      URL.revokeObjectURL(url);
      S.urls.delete(url);
    }
  }

  log('offscreen-документ загружен');
})();
