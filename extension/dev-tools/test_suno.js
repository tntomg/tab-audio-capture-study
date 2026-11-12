// Тест парсера метаданных Suno (SSR flight data self.__next_f)
// на синтетической странице test_page_suno.html. Без сети.
const fs = require('fs');

const html = fs.readFileSync('./test_page_suno.html', 'utf8');

function decodeNextFlight(text) {
  const out = [];
  const re = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    try { out.push(JSON.parse(m[1])); } catch (e) { /* skip */ }
  }
  return out.join('');
}

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
    let start = text.lastIndexOf('{', idx);
    while (start >= 0) {
      const end = scanObjectEnd(text, start);
      if (end > idx) {
        try {
          const o = JSON.parse(text.slice(start, end + 1));
          if (o && o.entity_type === 'song_schema') { out.push(o); break; }
        } catch (e) { /* try outer */ }
      }
      start = text.lastIndexOf('{', start - 1);
    }
  }
  return out;
}

const PATH = '/song/11111111-2222-3333-4444-555555555555';
const flight = decodeNextFlight(html);
const objs = collectSongObjects(flight);
const pathId = (PATH.match(/\/song\/([0-9a-f-]{36})/i) || [])[1] || null;
const clip = (pathId && objs.find((o) => o.id === pathId)) || objs[0];

const meta = clip && {
  site: 'Suno',
  uuid: clip.id,
  artist: clip.display_name || clip.handle || 'Suno',
  title: clip.title || 'song',
  image: clip.image_large_url || clip.image_url || null,
  genre: (clip.metadata || {}).tags || null,
  duration: (clip.metadata || {}).duration != null ? clip.metadata.duration : null,
  published: String(clip.created_at || '').slice(0, 10),
};

console.log('Найдено song_schema-объектов:', objs.length);
console.log('UUID:', meta && meta.uuid);
console.log('Artist:', meta && meta.artist);
console.log('Title:', meta && meta.title);
console.log('Genre:', meta && meta.genre);
console.log('Duration:', meta && meta.duration);
console.log('Published:', meta && meta.published);

const checks = [
  ['объектов', objs.length, 2],
  ['uuid', meta && meta.uuid, '11111111-2222-3333-4444-555555555555'],
  ['artist', meta && meta.artist, 'Test Artist'],
  ['title', meta && meta.title, 'Neon Sky'],
  ['cover', meta && meta.image, 'https://cdn2.suno.ai/cover.jpg'],
  ['genre', meta && meta.genre, 'synthpop, dreamy'],
  ['duration', meta && meta.duration, 123.4],
  ['published', meta && meta.published, '2026-01-31'],
  ['site', meta && meta.site, 'Suno'],
];
let bad = 0;
for (const [name, got, want] of checks) {
  if (got !== want) { bad++; console.log('FAIL', name, '- got', got, 'want', want); }
}
if (bad) { console.log('FAILED:', bad); process.exit(1); }
console.log('OK: Suno metadata parsed (split flight chunks + path id selection)');
