// Тест regex-парсинга метаданных на реальной HTML-странице Udio
const fs = require('fs');
const html = fs.readFileSync(
  './test_page.html', 'utf8');
const un = html.replace(/\\u0022/g, '"').replace(/\\"/g, '"');
const re = /"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})","user_id":"[0-9a-f-]{36}","artist":"([^"]*)","artist_image":"[^"]*","title":"([^"]*)"/;
const m = un.match(re);
if (m) {
  console.log('UUID:', m[1]);
  console.log('Artist:', m[2]);
  console.log('Title:', m[3]);
} else {
  console.log('NOT FOUND');
}
