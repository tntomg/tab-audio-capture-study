// Тест lamejs + ID3-билдера в Node
const fs = require('fs');
const path = require('path');
const lamePath = path.join(__dirname, '..', 'lib', 'lame.min.js');
const src = fs.readFileSync(lamePath, 'utf8');
const lamejs = new Function(src + '; return lamejs;')();

// --- smoke-тест энкодера ---
const enc = new lamejs.Mp3Encoder(2, 48000, 320);
const N = 48000; // 1 секунда
const L = new Int16Array(N);
const R = new Int16Array(N);
for (let i = 0; i < N; i++) {
  const v = Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 12000);
  L[i] = v; R[i] = v;
}
let total = 0;
const parts = [];
for (let o = 0; o < N; o += 9216) {
  const b = enc.encodeBuffer(L.subarray(o, Math.min(o + 9216, N)),
                             R.subarray(o, Math.min(o + 9216, N)));
  if (b.length) { parts.push(new Uint8Array(b)); total += b.length; }
}
const fl = enc.flush();
if (fl.length) { parts.push(new Uint8Array(fl)); total += fl.length; }
console.log('lamejs smoke-тест: OK, байт на 1с аудио =', total);

// --- копия ID3-логики из content.js ---
function u16le(str) {
  const out = [0xff, 0xfe];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out.push(c & 0xff, (c >> 8) & 0xff);
  }
  return Uint8Array.from(out);
}
function asciiBytes(str) {
  const a = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
  return a;
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
  p[0] = 1; p.set(t, 1);
  return id3Frame(id, p);
}
function buildId3(meta, cover) {
  const frames = [];
  if (meta.title) frames.push(textFrame('TIT2', meta.title));
  if (meta.artist) frames.push(textFrame('TPE1', meta.artist));
  frames.push(textFrame('TALB', 'Udio'));
  const body = (function concat(arrs) {
    let n = 0; for (const a of arrs) n += a.length;
    const out = new Uint8Array(n); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  })(frames);
  const tag = new Uint8Array(10 + body.length);
  tag.set(asciiBytes('ID3'), 0);
  tag[3] = 3; tag[4] = 0; tag[5] = 0;
  const sz = body.length;
  tag[6] = (sz >>> 21) & 0x7f; tag[7] = (sz >>> 14) & 0x7f;
  tag[8] = (sz >>> 7) & 0x7f; tag[9] = sz & 0x7f;
  tag.set(body, 10);
  return tag;
}

const tag = buildId3({ title: 'Третье сентября тест', artist: 't1tanium' }, null);
const ok = tag[0] === 0x49 && tag[1] === 0x44 && tag[2] === 0x33;
console.log('ID3-заголовок:', ok ? 'OK' : 'FAIL', '| размер тега:', tag.length, 'байт');

// склеим тег + mp3 и сохраним для проверки ffprobe
const mp3 = new Uint8Array(total + tag.length);
mp3.set(tag, 0);
let oo = tag.length;
for (const p of parts) { mp3.set(p, oo); oo += p.length; }
const outPath = require('path').join(__dirname, 'test_output.mp3');
fs.writeFileSync(outPath, mp3);
console.log('test_output.mp3 записан');
