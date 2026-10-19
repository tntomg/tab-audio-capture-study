// Тест buildWav: генерируем 2 секунды стерео-сиcнуса, проверяем валидность RIFF/WAVE
const fs = require('fs');

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

const rate = 48000;
const N = rate * 2; // 2 секунды
const L = new Int16Array(N);
const R = new Int16Array(N);
for (let i = 0; i < N; i++) {
  L[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 10000);
  R[i] = Math.round(Math.sin(2 * Math.PI * 880 * i / rate) * 8000);
}
const wav = buildWav(L, R, rate, {
  title: 'Третье сентября тест',
  artist: 't1tanium',
  published: '2024-04-18',
});
const outPath = require('path').join(__dirname, 'test_output.wav');
fs.writeFileSync(outPath, wav);
console.log('test_output.wav записан:', wav.length, 'байт');
console.log('первые 4 байта:', String.fromCharCode(...wav.slice(0, 4)));
