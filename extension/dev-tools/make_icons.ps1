# Генерация иконок расширения
Add-Type -AssemblyName System.Drawing

$icons = 'C:\AppProjects\UdioDownloader\extension\icons'
New-Item -ItemType Directory -Path $icons -Force | Out-Null

function Pt([float]$x, [float]$y, [float]$u) {
    return New-Object System.Drawing.PointF(($x * $u), ($y * $u))
}

foreach ($size in @(16, 48, 128)) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $u = [float]($size / 100.0)
    $r = [int]($size * 0.22)

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $path.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $path.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $path.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $path.CloseFigure()

    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(124, 58, 237))
    $g.FillPath($bg, $path)

    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $pts = @(
        (Pt 38 16 $u), (Pt 62 16 $u), (Pt 62 46 $u), (Pt 74 46 $u),
        (Pt 50 72 $u), (Pt 26 46 $u), (Pt 38 46 $u)
    )
    $arrow = New-Object System.Drawing.Drawing2D.GraphicsPath
    $arrow.AddPolygon($pts)
    $g.FillPath($white, $arrow)

    $bar = New-Object System.Drawing.RectangleF((26 * $u), (80 * $u), (48 * $u), (9 * $u))
    $g.FillRectangle($white, $bar)

    $g.Dispose()
    $bmp.Save((Join-Path $icons "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "icon$size.png готова"
}
