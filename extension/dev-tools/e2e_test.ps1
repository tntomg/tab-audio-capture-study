# E2E test for Udio Song Downloader extension (ASCII-only to avoid PS5.1 encoding issues)
param(
    [string]$ExtDir = 'C:\AppProjects\UdioDownloader\extension',
    [string]$Profile = 'C:\AppProjects\UdioDownloader\extension\dev-tools\chrome-test-profile',
    [string]$Url = 'https://www.udio.com/songs/sdF3W6WzYfsDdjnPThXFo2'
)
$chrome = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'

# kill previous test instances
$ours = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -match 'chrome-test-profile' }
foreach ($o in $ours) { Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
if (Test-Path $Profile) { Remove-Item $Profile -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host '=== Launching Chrome with extension ==='
Start-Process $chrome -ArgumentList @(
    "--user-data-dir=$Profile",
    "--load-extension=$ExtDir",
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check',
    '--window-position=80,80', '--window-size=1150,950',
    $Url
) | Out-Null
Write-Host 'Waiting 25s for page load...'
Start-Sleep -Seconds 25

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Find-Window {
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)
    $pids = (Get-Process chrome -ErrorAction SilentlyContinue).Id
    foreach ($root in $roots) {
        if ($root.Current.ProcessId -in $pids -and $root.Current.Name -match 'Udio') {
            return $root
        }
    }
    return $null
}

$win = Find-Window
if ($win) {
    Write-Host ('Window: ' + $win.Current.Name)
} else {
    Write-Host 'WINDOW NOT FOUND'
}

# click Play
if ($win) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'Play')
    $btn = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($btn) {
        $inv = $null
        if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
            $inv.Invoke()
            Write-Host '>>> Play clicked'
        }
    } else { Write-Host '>>> Play button not found' }
}

# monitor status via window title
Write-Host '=== Monitoring recording (up to 7 min) ==='
$deadline = (Get-Date).AddMinutes(7)
$lastTitle = ''
$phase = ''
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 20
    $w = Find-Window
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

# look for fresh MP3 in Downloads
$dl = "$env:USERPROFILE\Downloads"
$recent = Get-ChildItem $dl -Filter '*.mp3' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-12) } |
    Sort-Object LastWriteTime -Descending
if ($recent) {
    foreach ($f in $recent) { Write-Host ('FILE: ' + $f.Name + ' | ' + [math]::Round($f.Length / 1MB, 2) + ' MB') }
} else {
    Write-Host 'NO NEW MP3 FILES IN DOWNLOADS'
}
