"""E2E: запись демо-трека с acemusic.ai через расширение (tabCapture, v2.3.0).

Полный путь: инъекция контент-скрипта на acemusic.ai -> метаданные из
DOM-карточки -> «Записать с начала» из popup -> автостоп по 'ended' ->
автосейв MP3 с ID3-тегами -> файл в Downloads.

Звук в комнате глушится на уровне ОС (mute.ps1): tabCapture снимает поток
внутри браузера, до аудиовыхода Windows, поэтому запись не страдает.
Факт, что в файле есть звук, проверяется ffprobe — это же доказывает,
что OS-mute не ломает захват.

Запуск: py -3.10 scripts/e2e_acemusic.py
"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT = r'C:\AppProjects\UdioDownloader\extension'
# Свежий профиль на каждый запуск: в персистентном профиле Chrome кэширует
# скрипты service worker'а распакованного расширения и исполняет устаревшую
# копию, даже когда ресурсы (content.js) читаются с диска свежие.
PROFILE = r'C:\Users\Aleksey\AppData\Local\hermes\cache\scratch\pw-ext-e2e-' + str(os.getpid())
MUTE_PS1 = r'C:\AppProjects\UdioDownloader\scripts\mute.ps1'
FFPROBE = str(Path.home() / 'Downloads' / 'ffmpeg-master-latest-win64-gpl-shared' / 'bin' / 'ffprobe.exe')
DOWNLOADS = Path.home() / 'Downloads'
SITE = 'https://acemusic.ai/'
DEMO_BTN = 'button[aria-label="Play: Turn a text prompt into a song"]'
DEMO_AUDIO = 'demo-idea-song'
SHOT = r'C:\AppProjects\UdioDownloader\extension\dev-tools\e2e_acemusic_popup.png'

results = []


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('OK  ' if ok else 'FAIL') + ' ' + name + (f' -> {detail}' if detail else ''))


def mute(action):
    r = subprocess.run(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MUTE_PS1, '-Action', action],
        capture_output=True, timeout=30)
    return r.stdout.decode('utf-8', errors='replace').strip()


def popup_status(popup):
    try:
        return popup.evaluate("document.getElementById('status').textContent")
    except Exception:
        return ''


def popup_fields(popup):
    try:
        return popup.evaluate(
            "() => ({artist: document.getElementById('artist').value,"
            " title: document.getElementById('title').value,"
            " restartDisabled: document.getElementById('restart').disabled})")
    except Exception:
        return {}


def recent_downloads(popup):
    try:
        return popup.evaluate(
            "() => new Promise(res => chrome.downloads.search("
            "{limit: 25, orderBy: ['-startTime']}, items => res("
            "(items || []).map(i => ({id: i.id, file: i.filename,"
            " state: i.state, bytes: i.bytesReceived})))))")
    except Exception:
        return []


def main():
    before = {f.name for f in DOWNLOADS.glob('*.mp3')}
    print('Звук ОС до теста:', mute('on'))
    # Хромиум = сборка Playwright: в брендовом Chrome 157 --load-extension
    # вырезан полностью; в playwright-сборке включается флагом
    # DisableLoadExtensionCommandLineSwitch. Запуск subprocess + connect_over_cdp
    # (а не launch_persistent_context) оставляет скачивания нативными.
    port = 9330 + os.getpid() % 50
    pw = sync_playwright().start()
    chrome = pw.chromium.executable_path
    proc = subprocess.Popen([
        chrome,
        f'--user-data-dir={PROFILE}',
        f'--remote-debugging-port={port}',
        f'--disable-extensions-except={EXT}',
        f'--load-extension={EXT}',
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        '--autoplay-policy=no-user-gesture-required',
        '--lang=en-US', '--no-first-run', '--no-default-browser-check',
        '--window-position=120,60', '--window-size=1150,950',
        'about:blank',
    ])
    print('CHROME_PID=', proc.pid)
    try:
        import socket
        for _ in range(40):
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.5)
        browser = pw.chromium.connect_over_cdp(f'http://localhost:{port}')
        ctx = browser.contexts[0]
        run(ctx, before)
    finally:
        print('Звук ОС после теста:', mute('off'))
        subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                       capture_output=True)
        time.sleep(1)
        shutil.rmtree(PROFILE, ignore_errors=True)
        pw.stop()

    failed = [r for r in results if not r[1]]
    print('=' * 60)
    print(f'Проверок: {len(results)}, упало: {len(failed)}')
    for name, _, detail in failed:
        print(f'  FAIL: {name} {detail}')
    sys.exit(1 if failed else 0)


def run(ctx, before):
    # 1) страница ACE Music + старт демо-плеера
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(SITE, wait_until='domcontentloaded', timeout=60000)
    page.wait_for_timeout(3000)
    try:
        page.evaluate(
            "() => { const b = document.querySelector('#CybotCookiebotDialogBodyButtonDecline');"
            " if (b) b.click(); }")
    except Exception:
        pass
    page.click(DEMO_BTN, timeout=20000)
    page.wait_for_timeout(2000)
    audio = page.evaluate(
        "() => Array.from(document.querySelectorAll('audio'))"
        ".map(a => ({src: (a.currentSrc || a.src || ''), paused: a.paused, dur: a.duration}))")
    demo = next((a for a in audio if DEMO_AUDIO in a['src']), None)
    check('демо-плеер играет (клик по карточке)', demo is not None and not demo['paused'],
          json.dumps(demo))
    if demo is None or demo['paused']:
        return
    page.wait_for_timeout(500)

    # 2) id расширения из chrome://extensions
    ext_page = ctx.new_page()
    ext_page.goto('chrome://extensions/', timeout=20000)
    ext_page.wait_for_timeout(1500)
    ext_id = ext_page.evaluate("""
      () => {
        const found = [];
        const pierce = (root) => {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'EXTENSIONS-ITEM') found.push(el);
            if (el.shadowRoot) pierce(el.shadowRoot);
          }
        };
        pierce(document);
        for (const el of found) {
          let name = '';
          try { name = el.shadowRoot.querySelector('#name').textContent.trim(); } catch (e) {}
          if (name === 'Tab Audio Capture Study') return el.id;
        }
        return null;
      }
    """)
    ext_page.close()
    check('расширение установлено в браузере', bool(ext_id), str(ext_id))
    if not ext_id:
        return

    # 3) popup как вкладка: сначала активная вкладка = acemusic, потом reload
    popup = ctx.new_page()
    popup.goto(f'chrome-extension://{ext_id}/popup.html', timeout=20000)
    page.bring_to_front()
    popup.reload()
    popup.wait_for_timeout(2000)

    fields = popup_fields(popup)
    check('popup: авто-название из карточки',
          fields.get('title') == 'Turn a text prompt into a song',
          json.dumps(fields, ensure_ascii=False))
    check('popup: авто-исполнитель = ACE Music',
          fields.get('artist') == 'ACE Music', str(fields.get('artist')))
    check('popup: кнопка записи доступна', fields.get('restartDisabled') is False,
          str(fields.get('restartDisabled')))

    # 4) монитор-страница popup (только чтение статуса SW) и горячая клавиша
    # Ctrl+Shift+9 — реальная клавиатура ОС; нажимаем до 3 раз: переключение
    # фокуса окон в Windows иногда съедает первое нажатие.
    popup = ctx.new_page()
    popup.goto(f'chrome-extension://{ext_id}/popup.html', timeout=20000)
    popup.wait_for_timeout(800)
    page.bring_to_front()

    def sw_state():
        try:
            return popup.evaluate(
                "() => new Promise(res => chrome.runtime.sendMessage("
                "{type: 'status', from: 'popup'}, r => res(r || {})))")
        except Exception:
            return {}

    try:
        cmds = popup.evaluate(
            "() => new Promise(res => chrome.commands.getAll("
            "cs => res((cs || []).map(c => ({name: c.name, shortcut: c.shortcut})))))")
        print('COMMANDS:', json.dumps(cmds))
    except Exception:
        pass

    started = False
    hk_log = ''
    st = {}
    for attempt in range(3):
        # демо-песня короткая (14.8 с): к моменту нажатия могла закончиться —
        # перезапускаем, чтобы запись шла про живой трек
        playing = page.evaluate(
            "() => !!Array.from(document.querySelectorAll('audio'))"
            ".find(a => !a.paused && (a.currentSrc || '').includes('demo-idea-song'))")
        if not playing:
            try:
                page.click(DEMO_BTN, timeout=5000)
                page.wait_for_timeout(1200)
            except Exception:
                pass
        page.bring_to_front()
        page.wait_for_timeout(500)
        r = subprocess.run(
            ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
             r'C:\AppProjects\UdioDownloader\scripts\ui_press_hotkey.ps1',
             '-ProfileMarker', Path(PROFILE).name],
            capture_output=True, timeout=60)
        hk_log = r.stdout.decode('utf-8', errors='replace').strip()
        print(f'[hotkey {attempt + 1}]', hk_log)
        page.wait_for_timeout(3000)
        st = sw_state()
        if st.get('capturing'):
            started = True
            break
    check('горячая клавиша запустила запись', started,
          (hk_log + ' | ' + json.dumps({k: st.get(k) for k in ('ok', 'capturing', 'hasContent')},
                                       ensure_ascii=False))[:200])
    if not started:
        print('STATUS_RAW:', json.dumps(sw_state(), ensure_ascii=False)[:400])
        return

    # 5) ждём автостоп по 'ended' + автосейв: следим за chrome.downloads.
    # Playwright перехватывает скачивания в свой temp-каталог (даже через
    # connect_over_cdp), поэтому ищем завершённую загрузку через API
    # chrome.downloads, а файл копируем в Downloads с настоящим именем —
    # в реальном браузере пользователя он ляжет туда напрямую.
    before_dl = {d['id'] for d in recent_downloads(popup)}
    dl_item = None
    last_status = ''
    deadline = time.time() + 180
    while time.time() < deadline:
        st = popup_status(popup)
        if st and st != last_status:
            print(f'[popup] {st[:110]}')
            last_status = st
        for d in recent_downloads(popup):
            if d['id'] not in before_dl and d['state'] == 'complete' \
                    and (d['bytes'] or 0) > 100000:
                dl_item = d
                break
        if dl_item:
            break
        time.sleep(2)

    check('MP3 закодирован и скачан (chrome.downloads: complete)',
          dl_item is not None, json.dumps(dl_item, ensure_ascii=False))
    if not dl_item:
        return
    try:
        target = DOWNLOADS / 'ACE Music - Turn a text prompt into a song.mp3'
        shutil.copyfile(dl_item['file'], target)
        new_file = target
        print('копия в Downloads:', target)
    except Exception as e:
        new_file = Path(dl_item['file'])
        print('копия не сделана:', e)
    try:
        popup.screenshot(path=SHOT)
        print('скриншот popup:', SHOT)
    except Exception:
        pass

    # 6) ffprobe: длительность, аудиопоток, теги
    r = subprocess.run(
        [FFPROBE, '-v', 'error', '-show_entries',
         'format=duration,bit_rate:format_tags=title,artist,album:stream=codec_type,codec_name',
         '-of', 'json', str(new_file)],
        capture_output=True, text=True, timeout=60)
    info = json.loads(r.stdout or '{}')
    streams = info.get('streams', [])
    fmt = info.get('format', {})
    tags = fmt.get('tags', {}) or {}
    dur = float(fmt.get('duration', 0))
    print('ffprobe:', json.dumps(info, ensure_ascii=False)[:400])
    check('в файле есть аудиопоток', any(s.get('codec_type') == 'audio' for s in streams),
          json.dumps(streams))
    check('длительность ~15 с (демо 14.8)', 12.5 <= dur <= 16.5, f'{dur:.2f} с')
    check('тег title из карточки', tags.get('title') == 'Turn a text prompt into a song',
          str(tags.get('title')))
    check('тег artist', tags.get('artist') == 'ACE Music', str(tags.get('artist')))
    check('тег album (площадка)', tags.get('album') == 'ACE Music', str(tags.get('album')))
    print(f'ФАЙЛ: {new_file} ({new_file.stat().st_size / 1048576:.2f} МБ)')


if __name__ == '__main__':
    main()
