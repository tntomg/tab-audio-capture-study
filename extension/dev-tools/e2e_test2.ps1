# E2E test v3: install unpacked extension via chrome://extensions UI automation.
# NOTE (v2.0.0): title-monitoring через #udio-dl-debug больше не поддерживается
# (в v2 запись ведёт offscreen-документ). Скрипт по-прежнему ставит расширение,
# жмёт Play и проверяет появление MP3 в Downloads; статус записи смотри в консоли
# service worker расширения (edge://extensions -> Udio Song Downloader -> SW).
param(
    [string]$ExtDir = 'C:\AppProjects\UdioDownloader\extension',
    [string]$Profile = 'C:\AppProjects\UdioDownloader\extension\dev-tools\chrome-test-profile',
    [string]$SongUrl = 'https://www.udio.com/songs/sdF3W6WzYfsDdjnPThXFo2'
)
$chrome = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'

$ours = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -match 'chrome-test-profile' }
foreach ($o in $ours) { Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Write-Host '=== Launching Chrome (English UI, our pid tracked) ==='
$proc = Start-Process $chrome -ArgumentList @(
    "--user-data-dir=$Profile",
    '--lang=en-US',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check',
    '--window-position=60,60', '--window-size=1150,950',
    'about:blank'
) -PassThru
$ourPid = $proc.Id
Write-Host ("Our chrome pid: " + $ourPid)
Start-Sleep -Seconds 12

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

function Get-OurWindow {
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($root in $roots) {
        if ($root.Current.ProcessId -eq $ourPid) { return $root }
    }
    return $null
}

function Type-Keys([string]$s) {
    [System.Windows.Forms.SendKeys]::SendWait($s.Replace('+', '{+}'))
}

function Navigate-Our([string]$url) {
    $w = Get-OurWindow
    if (-not $w) { return $false }
    $h = [IntPtr]::new($w.Current.NativeWindowHandle)
    [Win32]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 500
    Type-Keys '^l'
    Start-Sleep -Milliseconds 600
    Type-Keys $url
    Start-Sleep -Milliseconds 400
    Type-Keys '{ENTER}'
    return $true
}

function Invoke-ByName([string]$pattern) {
    $w = Get-OurWindow
    if (-not $w) { return $false }
    $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) {
        if ($el.Current.Name -match $pattern) {
            $inv = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
                $inv.Invoke(); return $true
            }
            $tog = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tog)) {
                $tog.Toggle(); return $true
            }
            $acc = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$acc)) {
                $acc.DoDefaultAction(); return $true
            }
        }
    }
    return $false
}

# 1) открываем chrome://extensions
Write-Host 'Opening chrome://extensions ...'
Navigate-Our 'chrome://extensions/' | Out-Null
Start-Sleep -Seconds 5

# 2) Developer mode
$ok = Invoke-ByName 'Developer mode'
Write-Host ("Developer mode: " + $ok)
if (-not $ok) { Write-Host 'FATAL: Developer mode not found'; exit 1 }
Start-Sleep -Seconds 2

# 3) Load unpacked
$ok = Invoke-ByName 'Load unpacked'
Write-Host ("Load unpacked: " + $ok)
if (-not $ok) { Write-Host 'FATAL: Load unpacked not found'; exit 1 }
Start-Sleep -Seconds 3

# 4) диалог выбора папки: печатаем путь + Enter
Write-Host 'Typing extension folder into dialog...'
Type-Keys $ExtDir
Start-Sleep -Milliseconds 500
Type-Keys '{ENTER}'
Start-Sleep -Seconds 5

# 5) проверка установки
$w = Get-OurWindow
$found = $false
if ($w) {
    $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) { if ($el.Current.Name -match 'Udio Song Downloader') { $found = $true; break } }
}
Write-Host ("Extension installed: " + $found)
if (-not $found) { Write-Host 'FATAL: extension not installed'; exit 1 }

# __PART2__
# open song page
Write-Host '=== Opening song page ==='
Navigate-Our $SongUrl | Out-Null
Start-Sleep -Seconds 30

# find and click Play (with retries, only in OUR window)
$clicked = $false
for ($i = 0; $i -lt 12 -and -not $clicked; $i++) {
    $win = Get-OurWindow
    if ($win) {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, 'Play')
        $btn = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($btn) {
            $inv = $null
            if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
                $inv.Invoke(); $clicked = $true; Write-Host '>>> Play clicked'
            }
        }
    }
    if (-not $clicked) { Start-Sleep -Seconds 5 }
}
if (-not $clicked) { Write-Host 'WARNING: Play never clicked' }

# monitor via title
Write-Host '=== Monitoring recording (up to 7 min) ==='
$deadline = (Get-Date).AddMinutes(7)
$lastTitle = ''
$phase = ''
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 20
    $w = Get-OurWindow
    if (-not $w) { continue }
    $t = $w.Current.Name
    if ($t -ne $lastTitle) {
        Write-Host ("[{0:mm:ss}] {1}" -f (Get-Date), $t)
        $lastTitle = $t
    }
    if ($t -match '\[dl:encoding') { $phase = 'encoding'; continue }
    if ($t -match '\[dl:ready') {
        if ($phase -eq 'encoding' -or $phase -eq 'seen-ready') { $phase = 'done'; break }
        $phase = 'seen-ready'
    }
}
if ($phase -ne 'done') { Write-Host 'NOTE: recording did not finish as expected' }
Write-Host 'Waiting for encoding+download (35s)...'
Start-Sleep -Seconds 35

$dl = "$env:USERPROFILE\Downloads"
$recent = Get-ChildItem $dl -Filter '*.mp3' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-12) } |
    Sort-Object LastWriteTime -Descending
if ($recent) {
    foreach ($f in $recent) { Write-Host ('FILE: ' + $f.Name + ' | ' + [math]::Round($f.Length / 1MB, 2) + ' MB') }
} else {
    Write-Host 'NO NEW MP3 FILES IN DOWNLOADS'
}
