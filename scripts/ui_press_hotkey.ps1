# Выносит окно Chrome (по маркеру профиля в командной строке) на передний
# план и отправляет Ctrl+Shift+9 — горячую клавишу «Записать с начала».
# Реальная клавиатура ОС: команда расширения срабатывает как жест
# пользователя (invocation для tabCapture).
#
# Windows запрещает SetForegroundWindow из фонового процесса (foreground
# lock) — обходим классическим ALT-хаком и проверяем GetForegroundWindow,
# пока окно действительно не станет активным. Только тогда SendKeys.
param([string]$ProfileMarker = 'pw-ext-e2e')

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Hk {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@

$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -match $ProfileMarker }
$ours = @($procs | ForEach-Object { $_.ProcessId })
if (-not $ours -or $ours.Count -eq 0) { Write-Output 'ERR=no-chrome'; exit 1 }

$roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition)
$win = $roots | Where-Object { $ours -contains $_.Current.ProcessId } | Select-Object -First 1
if (-not $win) { Write-Output 'ERR=no-window'; exit 1 }
$h = [IntPtr]::new($win.Current.NativeWindowHandle)

$focused = $false
for ($i = 0; $i -lt 8; $i++) {
    # ALT down/up: имитация ввода снимает foreground lock для этого процесса
    [Win32Hk]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [Win32Hk]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [Win32Hk]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 150
    if ([Win32Hk]::GetForegroundWindow() -eq $h) { $focused = $true; break }
}
if (-not $focused) { Write-Output 'ERR=no-focus'; exit 1 }

Start-Sleep -Milliseconds 350
# ^=Ctrl +=Shift; 9 — обычная цифра
[System.Windows.Forms.SendKeys]::SendWait('^+9')
Start-Sleep -Milliseconds 250
Write-Output 'HOTKEY=SENT'
