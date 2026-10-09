# 一键打包：生成可交付的 .zip 与 .jar（两者字节完全相同）
#
# 用法：
#   pwsh -File tools/pack.ps1                 # 输出到扩展目录的上一级
#   pwsh -File tools/pack.ps1 -OutDir D:\out  # 指定输出目录
#   双击 tools\pack.cmd                        # 最省事
#
# 为什么 .jar 也要生成：.jar 本身就是 zip 格式，主人习惯用这个后缀；
# 两个文件内容一致，Chrome 装扩展用 .zip 那个即可。
#
# 打包内容：扩展目录下除 .git / tools / 已有的 zip、jar 之外的全部文件，
# 顶层保持一层 jd-auto-review-ext/ ，解压出来就能直接「加载已解压的扩展程序」。

[CmdletBinding()]
param(
  [string]$OutDir,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$root = Split-Path -Parent $PSScriptRoot                       # 扩展目录（tools 的上一级）
$name = Split-Path $root -Leaf                                 # 例如 jd-auto-review-ext
$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "找不到 manifest.json：$manifestPath" }
$version = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version
if (-not $OutDir) { $OutDir = Split-Path -Parent $root }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$baseName = "$name-v$version"
$zipPath = Join-Path $OutDir "$baseName.zip"
$jarPath = Join-Path $OutDir "$baseName.jar"

# 不打包进去的东西：版本库目录、打包工具自身、上一次的产物
$skipDir = @('.git', 'tools', 'node_modules')
$skipExt = @('.zip', '.jar')

foreach ($p in @($zipPath, $jarPath)) { if (Test-Path $p) { Remove-Item $p -Force } }

$files = Get-ChildItem $root -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($root.Length + 1)
  $parts = $rel -split '[\\/]'
  ($parts | Where-Object { $skipDir -contains $_ }).Count -eq 0 -and
  ($skipExt -notcontains $_.Extension.ToLower())
}

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
    $entry = "$name/$rel"
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $f.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $zip.Dispose() }

Copy-Item $zipPath $jarPath -Force

$zipLen = (Get-Item $zipPath).Length
$sha = (Get-FileHash $zipPath -Algorithm SHA256).Hash
$same = (Get-FileHash $jarPath -Algorithm SHA256).Hash -eq $sha

if (-not $Quiet) {
  Write-Host ''
  Write-Host "打包完成（$($files.Count) 个文件）" -ForegroundColor Green
  Write-Host "  ZIP : $zipPath"
  Write-Host "  JAR : $jarPath"
  Write-Host ("  大小: {0:N0} 字节   两份内容一致: {1}" -f $zipLen, $same)
  Write-Host "  SHA256: $sha"
  Write-Host ''
  Write-Host '上传到 GitHub Release：' -ForegroundColor Cyan
  Write-Host "  https://github.com/fanqie2025/jd-auto-review-ext/releases"
  Write-Host ''
}

[pscustomobject]@{
  Version = $version
  Files   = $files.Count
  Zip     = $zipPath
  Jar     = $jarPath
  Bytes   = $zipLen
  Sha256  = $sha
  Identical = $same
}
