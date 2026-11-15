<#
.SYNOPSIS
  Builds the Microsoft Store MSIX package for SpaceSense AI.

.DESCRIPTION
  1. Builds the release exe (npm run tauri build -- --no-bundle)
  2. Stages exe + AppxManifest.xml + generated logo assets
  3. Generates resources.pri (makepri) and packs the .msix (makeappx)

  The package is NOT signed: Partner Center signs it during Store submission.
  Use -SkipBuild to repackage the existing release exe.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-msix.ps1
#>
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)

# --- version: tauri.conf.json "x.y.z" -> "x.y.z.0" (Store requires revision 0) ---
$conf = [IO.File]::ReadAllText("$root\src-tauri\tauri.conf.json", $utf8) | ConvertFrom-Json
$version = "$($conf.version).0"
if ($version -notmatch '^[1-9]\d*\.\d+\.\d+\.0$') {
    throw "Version '$($conf.version)' is not usable for the Store (need x.y.z with x >= 1)."
}

# --- locate Windows SDK tools ---
$kits = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
$sdk = Get-ChildItem $kits -Directory |
    Where-Object { $_.Name -match '^10\.' -and (Test-Path "$($_.FullName)\x64\makeappx.exe") } |
    Sort-Object { [version]$_.Name } | Select-Object -Last 1
if (-not $sdk) { throw "Windows SDK (makeappx.exe) not found under $kits" }
$makeappx = "$($sdk.FullName)\x64\makeappx.exe"
$makepri = "$($sdk.FullName)\x64\makepri.exe"

# --- build exe ---
$exe = "$root\src-tauri\target\release\spacesense-ai.exe"
if (-not $SkipBuild) {
    Push-Location $root
    try {
        npm run tauri build -- --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
}
if (-not (Test-Path $exe)) { throw "Release exe not found: $exe" }

# --- stage layout ---
$work = "$root\src-tauri\target\msix"
$layout = "$work\layout"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force "$layout\Assets" | Out-Null
Copy-Item $exe $layout

$manifest = [IO.File]::ReadAllText("$root\msix\AppxManifest.xml", $utf8).Replace('{{VERSION}}', $version)
[IO.File]::WriteAllText("$layout\AppxManifest.xml", $manifest, $utf8)

# --- logo assets from app-icon.png ---
Add-Type -AssemblyName System.Drawing
$src = [Drawing.Image]::FromFile("$root\app-icon.png")

function New-Asset([string]$name, [int]$w, [int]$h, [double]$fill) {
    $bmp = New-Object Drawing.Bitmap($w, $h, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([Drawing.Color]::Transparent)
    $side = [Math]::Round([Math]::Min($w, $h) * $fill)
    $x = [Math]::Floor(($w - $side) / 2)
    $y = [Math]::Floor(($h - $side) / 2)
    $g.DrawImage($src, [int]$x, [int]$y, [int]$side, [int]$side)
    $g.Dispose()
    $bmp.Save("$layout\Assets\$name.png", [Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

foreach ($scale in 100, 200, 400) {
    $f = $scale / 100
    New-Asset "StoreLogo.scale-$scale"         (50 * $f)  (50 * $f)  1.0
    New-Asset "Square44x44Logo.scale-$scale"   (44 * $f)  (44 * $f)  1.0
    New-Asset "Square71x71Logo.scale-$scale"   (71 * $f)  (71 * $f)  0.72
    New-Asset "Square150x150Logo.scale-$scale" (150 * $f) (150 * $f) 0.62
    New-Asset "Square310x310Logo.scale-$scale" (310 * $f) (310 * $f) 0.56
    New-Asset "Wide310x150Logo.scale-$scale"   (310 * $f) (150 * $f) 0.62
}
foreach ($size in 16, 24, 32, 48, 256) {
    New-Asset "Square44x44Logo.targetsize-$size" $size $size 1.0
    New-Asset "Square44x44Logo.targetsize-${size}_altform-unplated" $size $size 1.0
    New-Asset "Square44x44Logo.targetsize-${size}_altform-lightunplated" $size $size 1.0
}
$src.Dispose()

# --- resources.pri ---
$priConfig = "$work\priconfig.xml"
& $makepri createconfig /cf $priConfig /dq ko-KR /pv 10.0.0 /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed" }
# Drop <packaging> so everything lands in a single resources.pri (no resource packs).
[xml]$cfg = Get-Content $priConfig
$cfg.resources.SelectNodes('packaging') | ForEach-Object { [void]$cfg.resources.RemoveChild($_) }
$cfg.Save($priConfig)
& $makepri new /pr $layout /cf $priConfig /mn "$layout\AppxManifest.xml" /of "$layout\resources.pri" /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makepri new failed" }

# --- pack ---
$outDir = "$root\dist-msix"
New-Item -ItemType Directory -Force $outDir | Out-Null
$out = "$outDir\SpaceSenseAI_${version}_x64.msix"
& $makeappx pack /d $layout /p $out /o
if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed" }

$item = Get-Item $out
Write-Host ""
Write-Host ("MSIX ready: {0} ({1:N1} MB)" -f $item.FullName, ($item.Length / 1MB))
Write-Host "Upload this file in Partner Center > Packages. It is unsigned on purpose (the Store signs it)."
