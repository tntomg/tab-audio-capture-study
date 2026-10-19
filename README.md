<div align="center">

# 🎙️ Tab Audio Capture Study

### Why does no `.mp3` ever appear in DevTools while a song plays on a modern music platform?

[![License: MIT](https://img.shields.io/badge/license-MIT-7c3aed.svg)](LICENSE)
[![Chrome/Edge](https://img.shields.io/badge/Chrome%20%2F%20Edge-116%2B-4285F4.svg)](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
[![Manifest](https://img.shields.io/badge/Manifest-V3-34a853.svg)](extension/manifest.json)
[![DRM](https://img.shields.io/badge/DRM-not%20circumvented-brightgreen.svg)](#-the-full-legal--ethics-note)
[![UI](https://img.shields.io/badge/UI-EN%20%2F%20RU-ff6b35.svg)](#-quick-start)

*Curiosity project that got out of hand — frozen as an educational snapshot.*

</div>

---

## The short version

- 🔬 **A research report** on how music platforms store, deliver and protect audio — private object storage → HLS/CMAF packaging → SAMPLE-AES + Widevine/FairPlay → watermarking — **plus** a fully working MV3 extension that demonstrates what the browser's *own documented APIs* can and cannot see.
- 🎙️ The extension records, in real time (1×), the audio a tab **already plays to the user**, through the public `chrome.tabCapture` API — the same capability class as OBS Studio or the Windows Game Bar. No DRM is touched: the tap sits **after** the CDM. No keys, no decryption, no protected streams.
- 🕵️ Audio watermarking can attribute any recording to the playing account (report §6.2) — one reason this is a study vehicle, not a tool.

It started accidentally: a DevTools window open next to a playing song, and a question that wouldn't go away.

<details>
<summary><b>📖 The full legal &amp; ethics note</b> — please read before using</summary>

- **No DRM circumvention.** There is no key extraction, no decryption and no access to protected streams anywhere in this code. An early attempt to obtain decryption keys through public L3 CDMs failed outright; the report documents it as a negative result, and that experiment is deliberately not part of this repository.
- **Nothing is downloaded or scraped.** The extension records what the browser is already playing *to the user*. This is the well-known "analog hole", which platforms treat as an accepted, watermark-mitigated risk (report §6). Recording quality equals exactly what is audible; the process runs at 1× real time.
- **Documented APIs only.** No exploits. The platform-specific content script (metadata, passive player events) analyzes publicly observable page architecture and never alters the page's audio path.
- **Not affiliated** with, endorsed by, or connected to any platform or rights holder. All trademarks belong to their respective owners.
- **Your responsibility.** If you study or fork this: comply with the terms of service of any website and with copyright law in your jurisdiction. Do not record or redistribute content you don't have rights to.
- **Dormant.** This repository is a frozen study snapshot: not maintained, not distributed via the Chrome Web Store, not promoted as a product.
- **Rights holders:** if anything here concerns you, please open an issue — the repository will be archived or removed upon a legitimate request.

</details>

## 🚀 Quick start

```bash
git clone https://github.com/tntomg/tab-audio-capture-study.git
# или просто скачайте zip из Releases
```

1. `chrome://extensions` (или `edge://extensions`) → включить **Developer mode**
2. **Load unpacked** → выбрать папку `extension/`
3. Открыть popup расширения на любой странице со звуком

UI — английский по умолчанию, переключатель **EN/RU** в заголовке (выбор запоминается).
Диагностика в консоли — префиксы `[udio-dl-*]` (service worker / offscreen / content script).

<details>
<summary><b>🧪 Тесты (Node.js, без сети)</b></summary>

```bash
cd extension/dev-tools
node test_lame.js        # MP3 320 + ID3 → ffprobe-валидный файл
node test_wav.js         # RIFF/WAVE + LIST INFO
node test_regex.js       # парсер метаданных (синтетическая страница)
node smoke_test_sw.js    # service worker: топ-левел + полный цикл start/stop/save
```

</details>

## 🗺️ Where the tap sits — the whole point

```
encrypted HLS segments (.m4s)
        │
        ▼
   CDM (Widevine L3) ──decrypt──► decoder ──PCM──► tab audio mix
                                                    │
                    ┌───────────────────────────────┤
                    ▼                               ▼
            speakers (user hears it)        chrome.tabCapture
                                                    │
                                                    ▼
                                   offscreen document · AudioWorklet
                                   (audio render thread) → Int16 PCM
                                                    │
                                                    ▼
                                     lamejs MP3 320 / WAV + ID3
```

The one decision that determines everything in a capture tool is *where in the signal path you tap* — choose it against DRM, page JS load, tab visibility and autoplay policy **before** writing code. Everything else is implementation.

<details>
<summary><b>🔬 Engineering findings — the transferable part</b></summary>

1. **Choose the capture point first.** A browser-process tap survives DRM, SPA load, background throttling and autoplay policy; a page-JS tap survives none of them reliably.
2. **Never record music through `ScriptProcessorNode`** — its buffers are serviced by the page's main thread; a busy SPA or backgrounded tab punches gaps and clicks into both the file and the speakers. Use `AudioWorklet` (audio render thread); for extensions, browser-process capture is better still.
3. **`createMediaElementSource(el)` hijacks the element's audio** — playback then flows through your `AudioContext`, and a suspended context silences the site. A programmatic `btn.click()` from an extension message does NOT confer user activation, so `ctx.resume()` is denied.
4. **During `tabCapture` the tab is muted** — pass the stream through your graph so the user keeps hearing it.
5. **Player rebuffering = mid-song silence gaps** in the capture. Stitch: drop silent runs ≥ 1.5 s *including the blocks already buffered before the threshold tripped* (`chunks.length -= silChunks - 1`), or a 3 s stall leaves a 1.4 s hole.
6. **MV3 SW pitfalls:** a top-level `TypeError` surfaces as *"Service worker registration failed. Status code: 15"* with no line info — keep the top level throw-free, smoke-test the file in Node with a stubbed `chrome`. The tabCapture event is `onStatusChanged` ("Status", not "State"); react only to `'stopped'`.
7. **lamejs in-page** (320 kbps CBR, 48 kHz stereo) yields a valid MP3; hand-built ID3v2.3 (UTF-16 frames, syncsafe sizes) and RIFF/WAVE + LIST INFO read back correctly in ffprobe. Codec code can be trusted separately from capture code — test the halves independently.

</details>

## 📦 Repository

| Path | What it is |
|---|---|
| [`extension/`](extension/) | MV3 extension — service worker, offscreen document, AudioWorklet, lamejs. No build step, no external dependencies |
| [`ARCHITECTURE_AND_SECURITY_REPORT.md`](ARCHITECTURE_AND_SECURITY_REPORT.md) | The research report (RU): storage, delivery, DRM, threat model, watermarking |

Deliberately **not** included: the one-off research-phase capture pipeline, and any recorded media.

---

<div align="center">

**Status:** dormant study snapshot · not on the Chrome Web Store

**License:** [MIT](LICENSE)

</div>
